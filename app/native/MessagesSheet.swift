import SwiftUI

// MARK: - Message viewer sheet — latest 100 messages of a channel
// Content is untrusted Discord text: rendered as plain Text only (never markup).

struct MessagesSheet: View {
    let data: MessagesSheetData
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(data.channel.label) — \(data.messages.count) ข้อความล่าสุด")
                    .font(.system(.headline, design: .monospaced))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(Theme.dim)
                }
                .buttonStyle(.borderless)
                .keyboardShortcut(.cancelAction)
            }

            if data.messages.isEmpty {
                Text("(ไม่มีข้อความ)")
                    .font(.body.monospaced())
                    .foregroundStyle(Theme.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(data.messages) { msg in
                            messageRow(msg)
                        }
                    }
                }
            }
        }
        .padding(16)
        .frame(width: 680, height: 560)
        .background(Theme.panel)
    }

    private func messageRow(_ msg: MessageRow) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(msg.author_name ?? "?")
                    .font(.system(size: 12, weight: .heavy, design: .monospaced))
                    .foregroundStyle(msg.isBot ? Theme.accent : .white.opacity(0.9))
                    .lineLimit(1)
                if msg.isBot {
                    Text("bot")
                        .font(.system(size: 9, weight: .heavy, design: .monospaced))
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Theme.accent.opacity(0.16)))
                }
                Spacer()
                Text(Fmt.rel(msg.ts))
                    .font(.caption2.monospaced())
                    .foregroundStyle(Theme.dim)
                    .help(Fmt.thShort(msg.ts))
            }
            Text(msg.bodyText)   // plain text — never interpreted as markup
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.white.opacity(0.75))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border.opacity(0.6)))
    }
}
