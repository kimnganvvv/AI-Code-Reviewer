# UI icons (sprite)

Paste file `sprite.svg` vào đây. Mỗi icon là một `<symbol>`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  <symbol id="empty" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z"/>
    <path d="m9 12 2 2 4-4"/>
  </symbol>
</svg>
```

Cách dùng:

- Web: `<svg class="icon"><use href="/static/icons/sprite.svg#empty"></use></svg>`
- Extension side panel: `<svg class="icon"><use href="../icons/sprite.svg#empty"></use></svg>`

Giữ `fill="none"` + `stroke="currentColor"` để icon tự đổi màu theo theme.
