import SwiftUI

// MARK: - Gaps section (hidden entirely until a scan has run — at == nil)

struct GapsView: View {
    @EnvironmentObject var store: BackfillStore

    var body: some View {
        if let at = store.gaps.at {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Text("GAPS")
                        .font(.caption.monospaced().weight(.heavy))
                        .foregroundStyle(.white.opacity(0.45))
                    Text("สแกนเมื่อ \(Fmt.thShort(at))")
                        .font(.caption2.monospaced())
                        .foregroundStyle(Theme.dim)
                    Spacer()
                    if store.gaps.gaps.isEmpty {
                        Text("ไม่พบ gap 🎉")
                            .font(.caption.monospaced().weight(.heavy))
                            .foregroundStyle(Theme.good)
                    } else {
                        Text("\(store.gaps.gaps.count) gaps")
                            .font(.caption.monospaced().weight(.heavy))
                            .foregroundStyle(Theme.warn)
                    }
                }

                if !store.gaps.gaps.isEmpty {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(store.gaps.gaps) { gap in
                                gapRow(gap)
                            }
                        }
                    }
                    .frame(maxHeight: 180)
                }
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border))
        }
    }

    private func gapRow(_ gap: Gap) -> some View {
        let badge = gap.badge
        return HStack(spacing: 10) {
            Text(badge.text)
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundStyle(badge.color)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Capsule().fill(badge.color.opacity(0.16)))
                .frame(width: 74)

            Text(gap.label)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(gap.name == nil ? Theme.dim : Theme.accent)
                .lineLimit(1)
                .frame(width: 200, alignment: .leading)

            Text(gap.guild ?? "—")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.white.opacity(0.6))
                .lineLimit(1)
                .frame(width: 140, alignment: .leading)

            Text(gap.detail)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.white.opacity(0.7))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            if gap.kind != "deleted" {
                Button {
                    store.startBackfill(gap.channelId)
                } label: {
                    Text("⬇ เติม")
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
                .disabled(store.jobRunning)
                .help("backfill \(gap.channelId) เต็ม")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.03)))
    }
}
