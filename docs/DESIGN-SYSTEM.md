# 拾光 design system

The default product language is a light, calm desktop workspace. Dark dashboard styling is not part of the current direction.

## Layout

```text
top product bar
  └─ feature rail | persistent session pane | overview or session workspace
```

- The session pane never disappears on desktop.
- Overview cards summarize; they do not replace the detailed workspace.
- Connection configuration stays in a small popover instead of occupying the main page.
- Commerce, refund and promotional controls from reference products are not part of 拾光.

## Color semantics

- QingTian green `#087e5b`: brand, waiting, healthy connection.
- Blue `#5867e8`: actively running.
- Amber `#e58a3b`: blocked, review attention, recovery.
- Red `#df5f66`: errors and destructive warnings only.
- Gray: offline and unavailable.

Surfaces use white, warm gray and pale mint. Status colors must not be used as decoration.

## Component rules

- Borders are preferred over heavy shadows.
- Radius stays between 9 and 17 pixels.
- Main text remains charcoal, never pure black.
- Disabled future features are visibly labeled and never pretend to work.
- Every status shown in color also has text and an accessible label.
