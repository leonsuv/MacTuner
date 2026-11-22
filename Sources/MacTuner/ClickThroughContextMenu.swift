import AppKit
import SwiftUI

/// Version-independent, zero-TCC, pure public AppKit + SwiftUI context menu engine.
/// Uses a non-activating floating `NSPanel` (`canBecomeKey == false`) + zero-hit-test `NSView` anchors
/// + a single `NSEvent.addLocalMonitorForEvents` so:
/// 1. The main MacTuner `NSWindow` NEVER resigns `keyWindow` while a context menu is open (avoiding
///    `NSHostingView.acceptsFirstMouse(for:) == false` drops on `Canvas` / `DragGesture` / `List`).
/// 2. Any outside left-click or right-click immediately closes the menu AND passes the real, unmodified
///    hardware `NSEvent` natively through `NSApp.sendEvent` on that exact same click (zero wasted clicks,
///    zero synthetic event replay, zero macOS-version-dependent `NSMenu` internals).
@MainActor
final class ClickThroughMenuManager {
    static let shared = ClickThroughMenuManager()

    fileprivate final class AnchorBox {
        weak var view: ClickThroughMenuAnchorNSView?
        init(_ view: ClickThroughMenuAnchorNSView) { self.view = view }
    }

    @Observable
    fileprivate final class HoverState {
        var pointInMenu: CGPoint?
    }

    private var anchors: [AnchorBox] = []
    private var panel: NonActivatingMenuPanel?
    private weak var parentWindow: NSWindow?
    private var openedAt: TimeInterval = 0
    private let hoverState = HoverState()
    private var localMonitor: Any?
    private var observersInstalled = false

    var isMenuVisible: Bool { panel?.isVisible == true }

    func installIfNeeded() {
        guard !observersInstalled else { return }
        observersInstalled = true

        localMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .scrollWheel, .keyDown]
        ) { [weak self] event in
            guard let self else { return event }
            var consume = false
            MainActor.assumeIsolated {
                consume = self.shouldConsumeLocalEvent(event)
            }
            return consume ? nil : event
        }

        let nc = NotificationCenter.default
        nc.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.dismiss() }
        }
        nc.addObserver(forName: NSWindow.didResignKeyNotification, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let self, let p = self.panel, p.isVisible,
                      let w = note.object as? NSWindow, w === self.parentWindow else { return }
                self.dismiss()
            }
        }
        nc.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let self, let p = self.panel, p.isVisible,
                      let w = note.object as? NSWindow, w === self.parentWindow else { return }
                self.dismiss()
            }
        }
    }

    fileprivate func register(_ view: ClickThroughMenuAnchorNSView) {
        installIfNeeded()
        anchors.removeAll { $0.view == nil || $0.view === view }
        anchors.append(AnchorBox(view))
    }

    fileprivate func unregister(_ view: ClickThroughMenuAnchorNSView) {
        anchors.removeAll { $0.view == nil || $0.view === view }
    }

    func dismiss() {
        hoverState.pointInMenu = nil
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
        panel.contentView = nil
    }

    private func shouldConsumeLocalEvent(_ event: NSEvent) -> Bool {
        let menuOpen = panel?.isVisible == true
        let isInsideMenu = menuOpen && (event.window === panel)

        switch event.type {
        case .mouseMoved:
            if menuOpen, let panel, let cv = panel.contentView {
                let screenPt = NSEvent.mouseLocation
                if panel.frame.contains(screenPt) {
                    let winPt = panel.convertPoint(fromScreen: screenPt)
                    hoverState.pointInMenu = CGPoint(x: winPt.x, y: cv.bounds.height - winPt.y)
                } else if hoverState.pointInMenu != nil {
                    hoverState.pointInMenu = nil
                }
            }
            return false

        case .keyDown:
            if menuOpen && event.keyCode == 53 { // Esc
                dismiss()
                return true
            }
            return false

        case .otherMouseDown:
            if menuOpen && !isInsideMenu {
                dismiss()
            }
            return false

        case .scrollWheel:
            // Ignore MacBook trackpad two-finger click/lift micro-scroll events (`.mayBegin`/`.ended`/small delta within 220ms)
            if menuOpen && !isInsideMenu {
                let elapsed = ProcessInfo.processInfo.systemUptime - openedAt
                let deliberate = abs(event.scrollingDeltaY) >= 4 || abs(event.scrollingDeltaX) >= 4
                if elapsed > 0.22 && deliberate && event.phase != .mayBegin && event.phase != .cancelled {
                    dismiss()
                }
            }
            return false

        case .leftMouseDown, .rightMouseDown:
            if isInsideMenu {
                if let panel, let cv = panel.contentView {
                    let winPt = event.locationInWindow
                    hoverState.pointInMenu = CGPoint(x: winPt.x, y: cv.bounds.height - winPt.y)
                }
                return false
            }

            // Outside click: close open menu immediately and let real hardware event pass through!
            if menuOpen {
                dismiss()
            }

            let isContextTrigger = (event.type == .rightMouseDown)
                || (event.type == .leftMouseDown && event.modifierFlags.contains(.control))

            if isContextTrigger, let win = event.window {
                let winPt = event.locationInWindow
                if let (anchor, localTopLeft) = hitTestAnchor(in: win, windowPoint: winPt) {
                    let screenPt = win.convertPoint(toScreen: winPt)
                    if presentMenu(from: anchor, localPoint: localTopLeft, screenPoint: screenPt, parentWindow: win) {
                        return true
                    }
                }
            }
            return false

        default:
            return false
        }
    }

    private func hitTestAnchor(in window: NSWindow, windowPoint: NSPoint) -> (ClickThroughMenuAnchorNSView, CGPoint)? {
        anchors.removeAll { $0.view == nil }
        var best: (view: ClickThroughMenuAnchorNSView, depth: Int, area: CGFloat, localPt: CGPoint)?

        for box in anchors {
            guard let v = box.view, v.window === window, !v.isHiddenOrHasHiddenAncestor else { continue }

            // Inside SwiftUI List (`NSTableRowView`), expand hit target across the full row width/height
            let hitTarget: NSView = enclosingTableRowView(of: v) ?? v
            // Intersect visibleRect with bounds (on macOS 14+, NSView.clipsToBounds defaults to false)
            let vis = hitTarget.visibleRect.intersection(hitTarget.bounds)
            guard !vis.isEmpty else { continue }
            let winRect = hitTarget.convert(vis, to: nil)
            guard winRect.contains(windowPoint) else { continue }

            var depth = 0
            var cur: NSView? = v
            while let p = cur?.superview { depth += 1; cur = p }
            let area = winRect.width * winRect.height

            let ptInV = v.convert(windowPoint, from: nil)
            let topLeftPt = CGPoint(x: ptInV.x, y: v.isFlipped ? ptInV.y : (v.bounds.height - ptInV.y))

            if let prev = best {
                if depth > prev.depth || (depth == prev.depth && area <= prev.area) {
                    best = (v, depth, area, topLeftPt)
                }
            } else {
                best = (v, depth, area, topLeftPt)
            }
        }
        return best.map { ($0.view, $0.localPt) }
    }

    private func enclosingTableRowView(of view: NSView) -> NSTableRowView? {
        var cur: NSView? = view.superview
        while let v = cur {
            if let row = v as? NSTableRowView { return row }
            cur = v.superview
        }
        return nil
    }

    private func presentMenu(from anchor: ClickThroughMenuAnchorNSView, localPoint: CGPoint, screenPoint: NSPoint, parentWindow: NSWindow) -> Bool {
        guard let builder = anchor.menuBuilder else { return false }
        var itemCount = 0
        let rawContent = builder(localPoint)

        let rootView = ClickThroughMenuContainer(
            hoverState: hoverState,
            onCountChange: { itemCount = $0 },
            onDismiss: { [weak self] in self?.dismiss() },
            content: rawContent
        )

        let hosting = FirstMouseHostingView(rootView: rootView)
        hosting.sizingOptions = [.intrinsicContentSize]
        let fitting = hosting.fittingSize
        guard itemCount > 0, fitting.width > 20, fitting.height > 16 else { return false }
        self.parentWindow = parentWindow
        self.openedAt = ProcessInfo.processInfo.systemUptime

        let effect = NSVisualEffectView(frame: NSRect(origin: .zero, size: fitting))
        effect.material = .menu
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 10
        effect.layer?.cornerCurve = .continuous
        effect.layer?.masksToBounds = true

        hosting.frame = effect.bounds
        hosting.autoresizingMask = [.width, .height]
        effect.addSubview(hosting)

        let p: NonActivatingMenuPanel
        if let existing = self.panel {
            p = existing
        } else {
            p = NonActivatingMenuPanel(
                contentRect: NSRect(origin: .zero, size: fitting),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            p.level = .popUpMenu
            p.isFloatingPanel = true
            p.becomesKeyOnlyIfNeeded = true
            p.acceptsMouseMovedEvents = true
            p.hidesOnDeactivate = true
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = true
            self.panel = p
        }

        p.contentView = effect
        p.setContentSize(fitting)

        let visibleFrame = (parentWindow.screen ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: -10000, y: -10000, width: 20000, height: 20000)
        var originX = screenPoint.x + 1
        var originY = screenPoint.y - fitting.height - 1

        if originX + fitting.width > visibleFrame.maxX - 4 {
            originX = max(visibleFrame.minX + 4, screenPoint.x - fitting.width - 1)
        }
        if originX < visibleFrame.minX + 4 {
            originX = visibleFrame.minX + 4
        }
        if originY < visibleFrame.minY + 4 {
            let flippedY = screenPoint.y + 1
            originY = (flippedY + fitting.height <= visibleFrame.maxY - 4)
                ? flippedY
                : max(visibleFrame.minY + 4, visibleFrame.maxY - fitting.height - 4)
        }

        p.setFrameOrigin(NSPoint(x: originX, y: originY))
        hoverState.pointInMenu = nil
        p.orderFront(nil)
        return true
    }
}

private final class NonActivatingMenuPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class ClickThroughMenuAnchorNSView: NSView {
    var menuBuilder: ((CGPoint) -> AnyView)?

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        MainActor.assumeIsolated {
            if window != nil {
                ClickThroughMenuManager.shared.register(self)
            } else {
                ClickThroughMenuManager.shared.unregister(self)
            }
        }
    }
}

private struct ClickThroughMenuContainer: View {
    let hoverState: ClickThroughMenuManager.HoverState
    let onCountChange: (Int) -> Void
    let onDismiss: () -> Void
    let content: AnyView

    var body: some View {
        ClickThroughMenuColumnLayout(spacing: 1, onCount: onCountChange) {
            content
        }
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(.secondary)
        .buttonStyle(ClickThroughMenuRowButtonStyle(hoverState: hoverState, onDismiss: onDismiss))
        .padding(5)
        .coordinateSpace(name: "clickThroughMenuRoot")
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.14), lineWidth: 0.5)
                .allowsHitTesting(false)
        )
    }
}

private struct ClickThroughMenuColumnLayout: Layout {
    var spacing: CGFloat = 1
    var onCount: ((Int) -> Void)?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        onCount?(subviews.count)
        guard !subviews.isEmpty else { return .zero }
        let naturalSizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let maxW = min(max(naturalSizes.map(\.width).max() ?? 180, 180), 460)
        var totalH: CGFloat = 0
        for (i, sv) in subviews.enumerated() {
            let s = sv.sizeThatFits(ProposedViewSize(width: maxW, height: nil))
            totalH += s.height + (i > 0 ? spacing : 0)
        }
        return CGSize(width: maxW, height: totalH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for sv in subviews {
            let natural = sv.sizeThatFits(.unspecified)
            let s = sv.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            let isSectionHeader = natural.height > 8 && natural.height < 20 && s.height < 20
            let insetX: CGFloat = isSectionHeader ? 10 : 0
            sv.place(
                at: CGPoint(x: bounds.minX + insetX, y: y),
                proposal: ProposedViewSize(width: max(0, bounds.width - insetX * 2), height: s.height)
            )
            y += s.height + spacing
        }
    }
}

private struct ClickThroughMenuRowButtonStyle: PrimitiveButtonStyle {
    let hoverState: ClickThroughMenuManager.HoverState
    let onDismiss: () -> Void

    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, hoverState: hoverState, onDismiss: onDismiss)
    }

    private struct RowBody: View {
        let configuration: Configuration
        let hoverState: ClickThroughMenuManager.HoverState
        let onDismiss: () -> Void
        @Environment(\.isEnabled) private var isEnabled
        @State private var rowFrame: CGRect = .zero

        private var isHovered: Bool {
            guard isEnabled, let pt = hoverState.pointInMenu else { return false }
            return rowFrame.contains(pt)
        }

        var body: some View {
            let isDestructive = configuration.role == .destructive
            HStack(spacing: 8) {
                configuration.label
                    .labelStyle(.titleAndIcon)
                    .font(.system(size: 13, weight: .regular))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(foreground(isDestructive: isDestructive))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(
                GeometryReader { geo in
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(isHovered ? (isDestructive ? Color.red : Color.accentColor) : Color.clear)
                        .onAppear { rowFrame = geo.frame(in: .named("clickThroughMenuRoot")) }
                        .onChange(of: geo.frame(in: .named("clickThroughMenuRoot"))) { _, f in rowFrame = f }
                }
            )
            .contentShape(Rectangle())
            .onTapGesture {
                guard isEnabled else { return }
                onDismiss()
                configuration.trigger()
            }
        }

        private func foreground(isDestructive: Bool) -> Color {
            if !isEnabled { return .secondary.opacity(0.45) }
            if isHovered { return .white }
            return isDestructive ? .red : .primary
        }
    }
}

private struct ClickThroughMenuAnchorRepresentable: NSViewRepresentable {
    let menuBuilder: (CGPoint) -> AnyView

    func makeNSView(context: Context) -> ClickThroughMenuAnchorNSView {
        let v = ClickThroughMenuAnchorNSView()
        v.menuBuilder = menuBuilder
        return v
    }

    func updateNSView(_ nsView: ClickThroughMenuAnchorNSView, context: Context) {
        nsView.menuBuilder = menuBuilder
    }
}

extension View {
    func clickThroughContextMenu<MenuContent: View>(
        @ViewBuilder menuItems: @escaping (CGPoint) -> MenuContent
    ) -> some View {
        modifier(ClickThroughContextMenuModifier(menuItems: menuItems))
    }

    func clickThroughContextMenu<MenuContent: View>(
        @ViewBuilder menuItems: @escaping () -> MenuContent
    ) -> some View {
        modifier(ClickThroughContextMenuModifier(menuItems: { _ in menuItems() }))
    }
}

private struct ClickThroughContextMenuModifier<MenuContent: View>: ViewModifier {
    @Environment(AppModel.self) private var appModel
    @Environment(\.colorScheme) private var colorScheme
    let menuItems: (CGPoint) -> MenuContent

    func body(content: Content) -> some View {
        content.background(
            ClickThroughMenuAnchorRepresentable { pt in
                AnyView(
                    menuItems(pt)
                        .environment(appModel)
                        .preferredColorScheme(colorScheme)
                )
            }
        )
    }
}
