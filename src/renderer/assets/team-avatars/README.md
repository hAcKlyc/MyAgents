# Team AI group avatars

Three multi-person illustrations selected by the user from the B「现代人物插画」
review board on 2026-10-31. These are generic group identities, not portraits of
actual members and not Agent icon candidates.

The existing review-board artwork was extracted without redrawing or palette
changes and resized with Lanczos3 to 128 × 128 PNG (lossless encoding). Together
the three production files are about 89 KiB and support the current 32 / 40px
display sizes at 2× density. Images are static imports bundled by Vite.
`PeerAvatar` owns the frontend rounded crop and the platform badge outside it.

Source: `exec-365a7e79-8a20-4c20-b486-ffc774ebe15c.png` (1536 × 1024) in this
chat's generated-image archive. Extracted regions, in pixels from the top left:

| File | x | y | width | height |
| --- | --- | --- | --- | --- |
| group-1.png | 52 | 528 | 247 | 247 |
| group-2.png | 337 | 528 | 247 | 247 |
| group-3.png | 622 | 528 | 247 | 247 |

Array order is stable: `PeerAvatar` selects a variant from the existing
sourceId seed, so renaming or reordering a group does not change its picture.
