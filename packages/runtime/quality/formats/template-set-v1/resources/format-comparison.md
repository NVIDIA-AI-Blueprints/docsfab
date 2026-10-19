# Format Comparison: MyST vs GFM vs RST

Guide for choosing the right template format variant.

## Decision Matrix

| Criterion | MyST (`.md`) | GFM (`-gfm.md`) | RST (`.rst`) |
|-----------|-------------|-----------------|-------------|
| **Platform** | Sphinx + MyST parser | GitLab/GitHub, any Markdown renderer | Sphinx (native) |
| **Admonitions** | `:::{note}` directives | `> **Note:**` blockquotes | `.. note::` directives |
| **In-page tabs** | `:::::{tab-set}` / `tab-item` | Not supported (use headings or details) | `.. tabs::` with sphinx-tabs |
| **Navigation tabs** | Book/collection navigation (not a body component) | Not supported | Book/collection navigation (not a body component) |
| **Grids/Cards** | `::::{grid}` + sphinx-design | Bullet lists with bold links | `.. grid::` with sphinx-design |
| **Diagrams** | `` {mermaid} `` directive | `` ```mermaid `` fenced block | `.. mermaid::` directive |
| **Cross-refs** | `{doc}`, `{ref}` roles | `[text](path.md)` relative links | `:doc:`, `:ref:` roles |
| **Tables** | `{list-table}` or pipe tables | Pipe tables only | `.. list-table::` or grid tables |
| **Dropdowns** | `:::{dropdown}` | `<details><summary>` HTML | `.. dropdown::` with sphinx-design |
| **Images** | `` {image} `` with width/align | `![alt](path)` | `.. image::` with options |
| **Anchors** | `(label)=` targets | None (use heading anchors) | `.. _label:` targets |
| **Learning curve** | Moderate (Markdown + directives) | Low (standard Markdown) | Steep (RST syntax) |

## When to Use Each

### MyST (`.md`) — Sphinx/MyST documentation sites

Choose MyST when:
- Building with Sphinx and the MyST parser
- Need rich layout (in-page tabs, grids, cards, dropdowns)
- Need precise cross-referencing between pages
- Using NVIDIA sphinx theme (`nvidia_sphinx_theme`)

### GFM (`-gfm.md`) — Generic Markdown

Choose GFM when:
- Publishing to GitLab/GitHub wikis or pages
- Need maximum portability across renderers
- Don't need advanced layout components
- Prefer standard Markdown without extensions

### RST (`.rst`) — Sphinx RST sites

Choose RST when:
- Existing Sphinx site uses RST (not migrating to MyST)
- Team is already fluent in RST syntax
- Need full Sphinx directive/role ecosystem

## Syntax Quick Reference

### Admonitions

**MyST:**
```markdown
:::{note}
This is a note.
:::
```

**GFM:**
```markdown
> **Note:** This is a note.
```

**RST:**
```rst
.. note::

   This is a note.
```

### Code Blocks with Tabs

**MyST:**
```markdown
:::::{tab-set}
::::{tab-item} Python
```python
print("hello")
```
::::
::::{tab-item} CLI
```bash
echo hello
```
::::
:::::
```

**GFM (fallback to headings):**
```markdown
#### Python
```python
print("hello")
```

#### CLI
```bash
echo hello
```
```

### Dropdowns

**MyST:**
```markdown
:::{dropdown} Advanced Configuration
Details here.
:::
```

**GFM:**
```markdown
<details>
<summary>Advanced Configuration</summary>

Details here.
</details>
```
