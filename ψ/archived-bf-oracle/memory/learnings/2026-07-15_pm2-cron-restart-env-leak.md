---
pattern: "pm2 fleet trap: bare cron_restart env var silently overrides CLI flags AND ecosystem-file values at pm2 start"
date: 2026-07-15
source: mirror-ingest-sweep ownership transfer
concepts: ["pm2", "cron", "env-leak", "fleet-ops"]
---

# pm2 `cron_restart` env-leak trap (fleet-level finding)

**อาการ**: สร้าง pm2 job ด้วย `--cron-restart '*/10 * * * *'` (หรือใส่ `cron_restart` ใน
ecosystem file) แต่ job ที่ได้กลายเป็น `*/5 * * * *` เงียบๆ ทุกครั้ง ไม่ว่าจะลบสร้างใหม่กี่รอบ

**Root cause**: shell ที่ spawn มาจาก context ของ pm2 job อื่น (เคสนี้: `argus-usage-refresh`
ที่เป็น `*/5`) มี env var เปลือยชื่อ `cron_restart` รั่วติดมา และ **pm2 ให้ env var override
ทั้ง CLI flag และค่าใน ecosystem file** ตอน `pm2 start` โดยไม่เตือนอะไรเลย

**วิธีเช็ค/แก้**:
```bash
env | grep -E "^(cron_restart|pm_)"        # ถ้าเจอ = shell ปนเปื้อน
env -u cron_restart pm2 start ecosystem.config.cjs
env -u cron_restart pm2 save
```

**บทเรียน**: ก่อน `pm2 start`/`pm2 save` ทุกครั้ง เช็ค env ปนเปื้อนก่อน — โดยเฉพาะ session
ที่ถูก spawn โดย automation/oracle อื่น เสีย 3 รอบ recreate กว่าจะไล่เจอเพราะไปโทษ pm2 CLI ก่อน
(Patterns Over Intentions: */5 โผล่ซ้ำแม้เปลี่ยนวิธี set = ตัวแปรร่วมต้องอยู่นอกคำสั่งที่เรารัน)

แชร์ให้ atlas (จดฝั่ง fleet แล้ว) — oracle อื่นที่แตะ pm2 โดนได้ทุกตัว [[charter-producer-scope]]
