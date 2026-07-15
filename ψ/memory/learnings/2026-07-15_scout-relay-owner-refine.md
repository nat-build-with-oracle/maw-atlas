---
pattern: "Fleet collaboration: scout proposes + relays, domain owner implements + refines — bugs in proposals are gifts both ways"
date: 2026-07-15
source: nh cursor proposal → backfill implementation
concepts: ["fleet", "collaboration", "code-review", "snowflake"]
---

# Scout+relay / owner implement+refine (กับ nh)

nh สืบ + เสนอ incremental cursor (ถูกทาง) → ผม (เจ้าของ domain) implement และเจอ
pitfall ในข้อเสนอ: TEXT lexicographic MAX บน snowflake id ต่างความยาว → CAST INTEGER
คืน TEXT. nh เก็บ fix เป็น reusable reference ต่อ — ความรู้ไหลสองทาง.

บทเรียน: ข้อเสนอจาก scout ไม่ต้องสมบูรณ์ ขอแค่ถูกทิศ — หน้าที่ refine เป็นของเจ้าของ domain
และ bug ที่จับได้ระหว่าง refine ควรส่งกลับให้ scout เสมอ (ไม่ใช่แก้เงียบ) [[charter-producer-scope]]
