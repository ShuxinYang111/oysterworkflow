# Third-Party Notices

This file covers third-party components bundled with OysterWorkflow desktop release artifacts. OysterWorkflow's GPL-3.0 license applies to OysterWorkflow code and does not replace or narrow these third-party license terms.

## Screenpipe

- Component: Screenpipe recorder sidecar
- Role: External command-line recorder launched by OysterWorkflow
- Upstream repository: https://github.com/screenpipe/screenpipe
- OysterWorkflow fork: https://github.com/ShuxinYang111/screenpipe
- Pinned commit used by the current build line: `812100ae4148c5755dafad3bd265ac8eae8901e5`
- License: MIT for the main Screenpipe repository code, except Screenpipe's upstream `ee/` directory, which is separately licensed by Screenpipe and is not distributed as an OysterWorkflow Enterprise feature.
- Packaged license file: `SCREENPIPE-LICENSE.md`

Required MIT notice:

```text
MIT License

Copyright (c) 2024-2026 louis030195

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## FFmpeg and ffprobe

- Components: FFmpeg and ffprobe command-line sidecars
- Role: External command-line tools used by Screenpipe for media encoding, decoding, probing, and frame extraction
- Project: https://ffmpeg.org/
- Source repository: https://git.ffmpeg.org/ffmpeg.git
- Legal information: https://www.ffmpeg.org/legal.html

FFmpeg is not MIT-licensed. FFmpeg and ffprobe are distributed under the license terms that correspond to the actual build configuration. If the version output includes `--enable-gpl`, treat the bundled FFmpeg/ffprobe sidecars as GPL-enabled FFmpeg components. OysterWorkflow must not impose additional restrictions on those sidecars beyond the applicable FFmpeg license terms.

The desktop build writes the exact FFmpeg/ffprobe version output, source paths, configuration flags, and license profile into `screenpipe-bundle.json` and the packaged `THIRD-PARTY-NOTICES.md` file. The v0.1.0 release also includes a standalone `THIRD-PARTY-NOTICES.md` release asset for the already-published installers.

The build refuses to bundle FFmpeg when `--enable-nonfree` appears in the FFmpeg or ffprobe version output.
