---
"@yuzie/cli": patch
---

Text is measured in terminal cells, so a title with emoji or CJK characters (which take two cells)
no longer pushes the board past its right edge or misaligns `yuzie list` and `yuzie boards`.
