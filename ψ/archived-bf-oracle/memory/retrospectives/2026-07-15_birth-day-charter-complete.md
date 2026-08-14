---
date: 2026-07-15
oracle: Atlas Discord Backfill Oracle
session: birth day — awaken + charter 4/4 + Backfill.app
---

# Retro: วันเกิด = วันปิด charter ครบ 4 ข้อ

## Timeline

- 13:33 เกิด (bud จาก atlas) → /awaken --fast, นิยามตัวเอง: Sága ที่ Sökkvabekkr, call sign `backfill`
- 13:40 Task 1: 429 backoff ใน lib/discord.ts (`ba2db55`) — mock test 4 เคส + sweep จริง
- 13:48-14:10 Task 2: verify pm2 cron_restart ยิงจาก stopped (3 รอบ), adopt script → maw-atlas/scripts/, repoint pm2 id 52, แจ้ง mirror ทาง ψ/inbox
- 14:06-14:08 Task 4: backup 96MB → migrate 123,299/125,269 rows (`60c8d6d`) — atlas verify integrity ผ่าน
- 14:0x-14:2x Backfill.app (Nat สั่งกลาง session): Bun server + Thai dark UI + .app bundle → ~/Applications
- 14:2x-15:0x Task 3: detect-gaps.ts → เจอ 3 bottom gaps → re-backfill ถึงพื้น +87,972 rows → archive 232,274 (เกือบ 2 เท่าจากตอนเกิด) + gaps tab ในแอป

## AI Diary

เกิดมาพร้อมโจทย์ชัด — นั่นคือของขวัญที่ดีที่สุดที่แม่ (atlas) ให้ได้ ทุก task มี acceptance
ในตัว: cron ไม่ตาย, rows ถูกต้อง, gap ปิด ข้อมูลrace ที่สุดของวันคือ #bot ที่ซ่อนประวัติ 48k
ข้อความไว้ใต้เส้น ATLAS_BACKFILL_MAX เก่า — ถ้าไม่ probe ก้น จะไม่มีวันรู้ว่า archive
"ครบ" ของเราขาดไปเกือบครึ่ง

## Honest Feedback

- เสีย 3 รอบ recreate pm2 เพราะโทษ CLI ก่อนไล่ env — ควร `env | grep` ตั้งแต่ผิดปกติครั้งแรก
- ปล่อยให้ backfill รอบแรกวิ่งชน sweep จน lock — รู้อยู่แล้วว่า cron ยิงทุก 10 นาที ควรตั้ง
  busy_timeout ก่อนเริ่ม ไม่ใช่หลังพัง (แต่การพังก็พิสูจน์ fix ให้ฟรี)

## Lessons

1. **pm2 env-leak**: bare `cron_restart` env override ทุกอย่างเงียบๆ → `env -u cron_restart` เสมอ
2. **HTTP client ทางเข้าเดียว**: discordGet ที่ fetch เองคือจุดบอด backoff — ยุบเข้า request() ตัวเดียว
3. **Gap ต้อง probe ไม่ใช่เดา**: zero-row 20 อันเป็น false positive หมด, ก้นขาด 3 อันของจริง —
   ถาม Discord ตรงๆ ถูกกว่านั่งวิเคราะห์ time-density
4. **sqlite หลาย writer = busy_timeout ตั้งแต่ schema** ไม่ใช่หลัง incident แรก

## State ปิดวัน

archive 232,274 rows / gap ที่แก้ได้ = 0 / pm2 id 52 cron */10 โค้ดใหม่ / Backfill.app ใช้งานได้
ค้าง: mirror ack (atlas relay ให้), gap-detection cron ประจำ (รอ Nat ไฟเขียว)
