# Third-party notices

This project is distributed as **source code**. It does not bundle or
redistribute the dependencies below: the setup script installs them from npm
and PyPI on the user's machine. If you distribute a *built* bundle (a zip, an
installer, a container image, or anything that includes `node_modules/`, the
`.venv/`, or compiled binaries), you must comply with the licenses below for
everything you include.

## JavaScript / Node dependencies

| Package | License | Copyright / upstream |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` (and its `@earendil-works/*` runtime packages) | MIT | Copyright (c) 2025 Mario Zechner — https://github.com/earendil-works/pi |
| `@playwright/mcp` and `playwright-core` | Apache-2.0 | Copyright Microsoft Corporation — https://github.com/microsoft/playwright-mcp |
| `@modelcontextprotocol/sdk` | MIT | Model Context Protocol contributors |
| `typebox` | MIT | Copyright (c) 2017–2025 Haydn Paterson — https://github.com/sinclairzx81/typebox |
| `sharp` | Apache-2.0 | Copyright Lovell Fuller and contributors — https://github.com/lovell/sharp |

`sharp`'s prebuilt platform packages (`@img/sharp-*`) are declared as
`Apache-2.0 AND LGPL-3.0-or-later` because they include libvips. Those binaries
ship inside `node_modules` after `npm install`; do not redistribute them in a
bundle without complying with LGPL-3.0 (license text, corresponding source or a
written offer, and no restriction on relinking).

A full audit of the npm dependency graph (241 packages) found only permissive
licenses: MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense, and
BlueOak-1.0.0. No GPL/AGPL code is present in the JavaScript tree.

## Python dependencies

| Package | License | Upstream |
| --- | --- | --- |
| `windows-mcp==0.8.7` | MIT | CursorTouch — https://github.com/CursorTouch/Windows-MCP |

`windows-mcp` pulls transitive packages that include **GPL-licensed** code:

- `fuzzywuzzy 0.18.0` — GPL-2.0
- `python-Levenshtein 0.27.5` — GPL-2.0-or-later

These are installed by `pip` at setup time from PyPI and are **not** part of
this repository. Publishing this repository as source plus the setup script
does not redistribute them, so their copyleft obligations do not attach to this
source distribution. If you ever ship a bundle that contains them (for example
a packaged virtual environment), you must comply with the GPL: include the
license texts, provide the corresponding source or a written offer, and add no
terms that conflict with the GPL.

The remaining transitive Python packages are permissively licensed (MIT, BSD,
Apache-2.0, PSF, MPL-2.0, ISC, Unlicense).

## Data

`resources/models-store.json` contains factual model metadata (model IDs,
names, context limits, token pricing, thinking-level maps) derived from the
MIT-licensed Pi model catalog and from public provider documentation. Pricing
and availability change over time; the file is informational only.

## Project assets

`resources/logo.png`, `resources/logo.ico`, `resources/favicon.png`, and the
copies under `dashboard/` are the project's own icon assets, supplied by the
project owner and distributed under the project's MIT license.

## Attribution text for MIT components

MIT-licensed components are used under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Apache-2.0 components are used under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0); their `NOTICE` files ship inside
their npm packages.
