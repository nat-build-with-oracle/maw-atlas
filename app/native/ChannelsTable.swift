import SwiftUI

// MARK: - Sortable channels table + search filter + per-row actions

struct ChannelsTable: View {
    @EnvironmentObject var store: BackfillStore
    @State private var search = ""
    @State private var sortOrder: [KeyPathComparator<ChannelRow>] = [
        KeyPathComparator(\ChannelRow.n, order: .reverse),
    ]

    private var rows: [ChannelRow] {
        let all = store.stats?.channels ?? []
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = q.isEmpty ? all : all.filter {
            $0.id.contains(q)
                || ($0.name?.lowercased().contains(q) ?? false)
                || ($0.guildName?.lowercased().contains(q) ?? false)
        }
        return filtered.sorted(using: sortOrder)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text("CHANNELS")
                    .font(.caption.monospaced().weight(.heavy))
                    .foregroundStyle(.white.opacity(0.45))
                Text("\(rows.count)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(Theme.dim)
                Spacer()
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.caption)
                        .foregroundStyle(Theme.dim)
                    TextField("ค้นหา channel / guild…", text: $search)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.white)
                        .frame(width: 220)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bg))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border))
            }

            Table(rows, sortOrder: $sortOrder) {
                TableColumn("channel", value: \.sortName) { c in
                    if c.name != nil {
                        Text(c.label)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Theme.accent)
                    } else {
                        Text(c.id)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Theme.dim)
                    }
                }
                .width(min: 180, ideal: 240)

                TableColumn("guild", value: \.sortGuild) { c in
                    Text(c.guildName ?? "—")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(c.guildName == nil ? Theme.dim : .white.opacity(0.85))
                }
                .width(min: 120, ideal: 170)

                TableColumn("ข้อความ", value: \.n) { c in
                    Text(Fmt.num(c.n))
                        .font(.system(size: 12, design: .monospaced))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .width(min: 80, ideal: 100)

                TableColumn("ล่าสุด", value: \.latest) { c in
                    Text(Fmt.thShort(c.latest))
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.7))
                }
                .width(min: 120, ideal: 140)

                TableColumn("actions") { c in
                    HStack(spacing: 6) {
                        actionButton("⬇ เต็ม", help: "backfill เต็ม (--full)") {
                            store.startBackfill(c.id)
                        }
                        .disabled(store.jobRunning)

                        actionButton("👁 ดู", help: "ดู 100 ข้อความล่าสุด") {
                            store.viewMessages(c)
                        }
                        .disabled(store.loadingMessagesFor != nil)

                        actionButton("JSON", help: "export JSON") {
                            store.export(c, format: "json")
                        }
                        actionButton("CSV", help: "export CSV") {
                            store.export(c, format: "csv")
                        }
                    }
                }
                .width(min: 230, ideal: 250)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.panel)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border))
            .frame(minHeight: 240, maxHeight: .infinity)
        }
    }

    private func actionButton(_ title: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .lineLimit(1)
                .fixedSize()
        }
        .buttonStyle(.borderless)
        .foregroundStyle(Theme.accent)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Capsule().fill(Theme.accent.opacity(0.12)))
        .overlay(Capsule().stroke(Theme.accent.opacity(0.35)))
        .help(help)
    }
}
