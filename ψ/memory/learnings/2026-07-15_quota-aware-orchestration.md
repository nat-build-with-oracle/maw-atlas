---
pattern: "Quota-aware orchestration: งานที่รู้ชิ้นส่วนชัด → inline; สงวน subagent ให้ discovery/verify ที่ fan-out จำเป็นจริง"
date: 2026-07-15
source: quota cliff กลาง wave 2 + nh ปรับ workflow ตาม (relay ผ่าน atlas)
concepts: ["orchestration", "quota", "fleet-ops", "efficiency"]
---

# Quota-aware orchestration (บทเรียนร่วม backfill + nh)

- วันนี้ quota subagent หมดกลาง wave: ครึ่งแรก (SwiftUI/CLI/restyle ที่ต้อง fan-out
  understand+verify+review) ได้ประโยชน์จาก workflow เต็มๆ; ครึ่งหลัง (tray/TUI/wrapper/Tauri
  ที่ผมรู้ pattern อยู่แล้ว) ทำ inline ได้เร็วพอกันและคุมคุณภาพเองได้
- Heuristic ที่ตกผลึก: **ถ้าบรรยาย spec ให้ agent ได้ละเอียดพอที่มันไม่ต้อง discover อะไร =
  เขียนเองเร็วกว่า** จ่าย quota เฉพาะตอนต้องการหลายมุมมอง/หลายตาจริง (adversarial verify,
  census, unknown codebase)
- ผลพลอยได้ที่ไม่ได้ตั้งใจ: O(new) incremental cursor ทำให้ inline ops เบาพอที่จะไม่ต้องพึ่ง
  agent เลย — efficiency ชั้น data ช่วย efficiency ชั้น orchestration [[charter-producer-scope]]
