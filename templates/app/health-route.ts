// src/app/api/health/route.ts — deploy-kit проверяет его после выкладки. 200 — приложение и база живы.
import { NextResponse } from "next/server";
import { db } from "@/lib/db"; // клиент базы проекта

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.$queryRaw`select 1`; // drizzle: await db.execute(sql`select 1`)
    return NextResponse.json({ ok: true, version: process.env.GIT_SHA ?? "dev" });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
