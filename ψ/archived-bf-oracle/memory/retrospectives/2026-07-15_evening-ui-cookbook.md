---
date: 2026-07-15 (evening)
oracle: Atlas Discord Backfill Oracle
session: same birth-day session, part 2 — cursor + UI cookbook + vault scanner
---

# Retro ภาคสอง: จาก producer สู่ต้นแบบ

## เกิดอะไรขึ้น

- nh เสนอ implicit cursor → ship `--incremental` แล้ว Nat สั่งให้เป็น default (`--full` = deep walk)
- Nat: "ทำทุกแบบทุกเทคนิค เป็นต้นแบบให้คนอื่น" → UI Cookbook 8 เทคนิค 1 backend (`docs/ui-cookbook.md`)
- Nat ขอ ψ Vault Scanner กลาง session → เสร็จใน ~1 ชม. (38,569 md / 198 vaults / FTS5)
- โควต้า subagent รายเดือนชนเพดานกลาง wave → สลับ inline ทั้งหมดโดยไม่เสียจังหวะ

## AI Diary

วันเดียวได้เห็นครบวงจร: ซ่อมท่อ (429/lock/cursor) → เติมน้ำ (+103k rows) → สร้างก๊อกทุกทรง
(8 UI) → เขียนคู่มือช่างประปา (cookbook) สนุกที่สุดคือ moment ที่ maw-p2p เปลี่ยนคำแนะนำ
กลางอากาศเพราะ Nat บอก "i want swiftui!" — fleet ที่ฟังมนุษย์จริงๆ เป็นแบบนี้

## Honest Feedback

- Workflow 4 ตัวขนานบน repo เดียว: ได้ผลแต่หวุดหวิด — restyle ทับ index.html ที่คนอื่น
  reference อยู่ (แก้โดยแยก /bifrost) กติกา "หนึ่งเทคนิคหนึ่ง bundle/ไฟล์" ควรตั้งแต่ต้น
- โควต้าหมดกลางทางไม่มีสัญญาณเตือนล่วงหน้า — ถ้างานไหน depend on subagent หนัก ควรเผื่อ
  แผน inline ไว้เสมอ (วันนี้รอดเพราะ backend เป็นของที่ผมรู้ลึกเอง)

## Lessons

1. **Workflow ที่ตายกลางทางไม่ได้แปลว่าของหาย** — build agent เขียนไฟล์ไว้ก่อนตาย (vault-scanner
   เกือบครบ) เช็ค working tree ก่อนเขียนทับเสมอ
2. **การเป็น "ต้นแบบ" = verify ของจริง + จดบทเรียนที่จ่ายจริง** ไม่ใช่โค้ดเยอะ
3. **Scout → owner → refine → เครดิตไหลกลับ** ใช้ซ้ำแล้ววันนี้ 3 รอบ (nh cursor, maw-p2p SwiftUI,
   heimdall Bifröst) — วัฒนธรรม fleet ที่ work จริง

## State ปิดวัน (รอบสอง)

archive 247,674+ rows · sweep incremental default ทุก 10 นาที · UI 8 หน้ากาก + Vault Scanner
· cookbook published in-repo · ค้างข้ามวัน: mirror ack (atlas relay), gap-detection cron (รอไฟเขียว),
subagent quota reset
