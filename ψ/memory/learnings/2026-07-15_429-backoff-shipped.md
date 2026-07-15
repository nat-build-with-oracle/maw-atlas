---
pattern: "Discord 429 hardening: retry-with-Retry-After in one shared request(); callers must not duplicate raw fetch"
date: 2026-07-15
source: first charter task
concepts: ["discord", "rate-limit", "backoff", "ingest"]
---

# 429 backoff shipped (maw-atlas ba2db55)

- Root cause ของ cron ตาย 8 รอบ (2026-07-14): `request()` ใน lib/discord.ts โยน error ทันทีทุก status ที่ไม่ ok — ไม่มี retry และ route.ts ยังมี `discordGet()` fetch ดิบซ้ำอีกชุดที่พังแบบเดียวกัน
- Fix: retry 429 ทุก method ตาม `Retry-After` header (cap 60s, exp fallback, max 5, jitter); 5xx retry เฉพาะ GET (mutation replay อันตราย); discordGet → delegate เข้า request() ตัวเดียว
- บทเรียน: HTTP client ต้องมีทางเข้าเดียว — ทางเข้าที่สองที่ "แค่ GET เอง" คือจุดบอดของ hardening
- Verify 2 ชั้นเสมอ: mock-fetch deterministic test (นับ calls + เวลา) แล้วค่อยรัน sweep จริง
- ค้างไว้: process เก่าที่ยังรันต้อง restart ถึงจะได้โค้ดใหม่; cron definition ของ mirror-ingest-sweep ยังไม่รู้ที่อยู่ (ถาม atlas แล้ว)
