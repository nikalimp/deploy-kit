// Типограф для исходников сайта: правит видимый русский текст в src/**/*.ts(x).
// @nikitos-shared typograf.mjs — общая версия в nikalimp/deploy-kit/shared; проектные проверки — scripts/check.local.mjs
// Трогает только текст в JSX и строковые литералы с кириллицей; код, классы, URL, типы — нет.
// Запускается сам перед каждой сборкой (prebuild). Вручную: npm run typograf  ·  проверка: npm run typograf:check
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { typograf } from "../src/lib/typograf.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP_FILES = /(llms|schema|posts|typograf|utils)\.(ts|mjs)$|route\.ts$|sitemap\.ts$|robots\.ts$/;
const SKIP_PROPS = new Set(["slug", "group", "href", "url", "src", "className", "key", "id", "booking", "telegram", "email"]);
const CYR = /[а-яё]/i;
const SENTINEL = "щ"; // подставляется перед {выражением}, чтобы предлог перед ним тоже «прилип»

const check = process.argv.includes("--check");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) && !/\.d\.m?ts$/.test(e.name) ? [p] : [];
  });
}

function t(text, glueEnd) {
  if (!CYR.test(text)) return text;
  if (glueEnd && / $/.test(text)) {
    const out = typograf(text + SENTINEL, { markdown: false });
    return out.endsWith(SENTINEL) ? out.slice(0, -1) : text;
  }
  return typograf(text, { markdown: false });
}

function skipString(node) {
  const p = node.parent;
  if (!p) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && SKIP_PROPS.has(p.name.text)) return true;
  if (ts.isJsxAttribute(p) && SKIP_PROPS.has(p.name.getText())) return true;
  if (ts.isBinaryExpression(p) || ts.isCaseClause(p) || ts.isElementAccessExpression(p)) return true;
  return false;
}

function escapeFor(quote, value) {
  return value.replace(/\\/g, "\\\\").replace(new RegExp(quote, "g"), `\\${quote}`).replace(/\n/g, "\\n");
}

let changedFiles = 0;
for (const file of walk(path.join(ROOT, "src"))) {
  if (SKIP_FILES.test(file)) continue;
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [];

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const next = node.parent.getChildren().flatMap((c) => (c.kind === ts.SyntaxKind.SyntaxList ? c.getChildren() : [c]));
      const i = next.indexOf(node);
      const glue = next[i + 1] && !ts.isJsxText(next[i + 1]) && next[i + 1].kind !== ts.SyntaxKind.LessThanSlashToken && !ts.isJsxClosingElement(next[i + 1]);
      const raw = src.slice(node.getStart(), node.getEnd());
      const out = t(raw, glue);
      if (out !== raw) edits.push([node.getStart(), node.getEnd(), out]);
    } else if (ts.isStringLiteral(node) && !skipString(node)) {
      const out = t(node.text, false);
      if (out !== node.text) {
        const q = src[node.getStart()];
        edits.push([node.getStart(), node.getEnd(), q + escapeFor(q, out) + q]);
      }
    } else if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && !skipString(ts.isNoSubstitutionTemplateLiteral(node) ? node : node.parent)) {
      // текст между ` и ${ … } — правим сырой кусок
      const start = node.getStart() + 1;
      const end = node.getEnd() - (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? 2 : 1);
      const raw = src.slice(start, end);
      if (!raw.includes("\\")) {
        const out = t(raw, ts.isTemplateHead(node) || ts.isTemplateMiddle(node));
        if (out !== raw) edits.push([start, end, out]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!edits.length) continue;
  changedFiles++;
  let out = src;
  for (const [s, e, r] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + r + out.slice(e);
  const rel = path.relative(ROOT, file);
  if (check) console.log(`${rel}: ${edits.length} правок`);
  else { fs.writeFileSync(file, out); console.log(`Типограф: ${rel} (${edits.length})`); }
}
if (check) { console.log(changedFiles ? `\nНужна типографика в ${changedFiles} файлах — npm run typograf` : "Типографика в порядке"); process.exit(changedFiles ? 1 : 0); }
if (!changedFiles) console.log("Типограф: без изменений");
