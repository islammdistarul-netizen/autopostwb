import { Config } from '@remotion/cli/config';

// Server-side render stability: see CLAUDE.md -> Remotion Server-Side Constraints.
// The orchestrator passes the same flags explicitly; this file makes
// `npm run studio` / `npm run render` behave identically.
Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
Config.setConcurrency(2);
Config.setChromiumOpenGlRenderer((process.env.CF_GL_RENDERER as 'angle' | 'swangle' | undefined) ?? 'angle');
Config.setOverwriteOutput(true);
Config.setPublicDir('storage/staged/public');

// Servers whose egress blocks remotion.media (headless-shell download) can point
// at a system chrome-headless-shell instead. New-headless Chrome is NOT enough.
if (process.env.CF_BROWSER_EXECUTABLE) {
  Config.setBrowserExecutable(process.env.CF_BROWSER_EXECUTABLE);
}
