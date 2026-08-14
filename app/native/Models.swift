import SwiftUI

// MARK: - Theme — echoes the web panel (app/index.html)

enum Theme {
    static let bg     = Color(red: 0x0d / 255.0, green: 0x11 / 255.0, blue: 0x17 / 255.0)
    static let panel  = Color(red: 0x16 / 255.0, green: 0x1b / 255.0, blue: 0x22 / 255.0)
    static let border = Color(red: 0x30 / 255.0, green: 0x36 / 255.0, blue: 0x3d / 255.0)
    static let accent = Color(red: 0x58 / 255.0, green: 0xa6 / 255.0, blue: 0xff / 255.0)
    static let dim    = Color(red: 0x8b / 255.0, green: 0x94 / 255.0, blue: 0x9e / 255.0)
    static let good   = Color(red: 0x3f / 255.0, green: 0xb9 / 255.0, blue: 0x50 / 255.0)
    static let warn   = Color(red: 0xd2 / 255.0, green: 0x99 / 255.0, blue: 0x22 / 255.0)
    static let bad    = Color(red: 0xf8 / 255.0, green: 0x51 / 255.0, blue: 0x49 / 255.0)
}

// MARK: - API models (field names match app/server.ts exactly)

struct Stats: Decodable {
    let total: Int
    let badRows: Int
    let lastSweep: String?
    let namesAt: Double
    let guilds: [String: String]
    let channels: [ChannelRow]
}

struct ChannelRow: Decodable, Identifiable, Hashable {
    let id: String            // channel_id
    let gid: String?          // guild_id
    let n: Int                // message count
    let latest: String        // MAX(ts), ISO
    let name: String?         // channel name (null until name sweep finishes)
    let guildName: String?

    // Non-optional keys for sortable Table columns
    var sortName: String { name ?? id }
    var sortGuild: String { guildName ?? "" }
    var label: String { name.map { "#\($0)" } ?? id }
}

struct MessageRow: Decodable, Identifiable {
    let message_id: String
    let channel_id: String
    let thread_id: String?
    let author_name: String?
    let author_is_bot: Int?
    let content: String?
    let attachments_json: String?
    let ts: String

    var id: String { message_id }
    var isBot: Bool { (author_is_bot ?? 0) != 0 }
    var bodyText: String {
        if let c = content, !c.isEmpty { return c }
        if let a = attachments_json, !a.isEmpty, a != "null", a != "[]" { return "📎 attachment" }
        return "(ว่าง)"
    }
}

struct JobState: Decodable {
    let title: String?
    let startedAt: String?
    let lines: [String]
    let done: Bool
    let code: Int?

    var running: Bool { title != nil && !done }
}

struct GapsResponse: Decodable {
    let at: String?
    let gaps: [Gap]

    static let empty = GapsResponse(at: nil, gaps: [])
}

struct Gap: Decodable, Identifiable {
    let kind: String
    let channelId: String
    let name: String?
    let guild: String?
    let detail: String

    var id: String { "\(kind):\(channelId):\(detail)" }
    var label: String { name.map { "#\($0)" } ?? channelId }

    /// Gap kind → (Thai badge label, color) — same mapping as the web panel.
    var badge: (text: String, color: Color) {
        switch kind {
        case "zero-row": return ("ว่าง", Theme.warn)
        case "bottom":   return ("ก้นขาด", Theme.bad)
        case "cursor":   return ("hole", Theme.bad)
        case "deleted":  return ("ตายแล้ว", Theme.dim)
        default:         return (kind.isEmpty ? "?" : kind, Theme.dim)
        }
    }
}

// MARK: - Formatters

enum Fmt {
    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso = ISO8601DateFormatter()
    private static let sqlite: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
    private static let thai: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "th_TH")
        f.dateStyle = .short
        f.timeStyle = .short
        return f
    }()
    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "th_TH")
        f.unitsStyle = .short
        return f
    }()
    private static let number: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    static func date(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return isoFrac.date(from: s) ?? iso.date(from: s) ?? sqlite.date(from: s)
    }

    /// th-TH short date+time, "—" when null/unparseable (same as web panel `fmtTs`).
    static func thShort(_ s: String?) -> String {
        guard let d = date(s) else { return "—" }
        return thai.string(from: d)
    }

    static func rel(_ s: String?) -> String {
        guard let d = date(s) else { return "—" }
        return relative.localizedString(for: d, relativeTo: Date())
    }

    static func num(_ n: Int) -> String {
        number.string(from: NSNumber(value: n)) ?? String(n)
    }
}
