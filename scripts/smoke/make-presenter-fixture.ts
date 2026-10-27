/**
 * Builds the synthetic "founder holding a phone" fixture used by the object-aware render tests:
 *   fixtures/render/presenter/presenter.mp4          full clip (720x1280, 6 s)
 *   fixtures/render/presenter/person-cutout.webm     person only, VP9 alpha (what SAM's person cutout would be)
 *   fixtures/render/presenter/phone-cutout.webm      phone only, VP9 alpha
 *   fixtures/render/presenter/tracks-person.json     TracksFile (ground truth from the motion model)
 *   fixtures/render/presenter/tracks-phone.json
 *   fixtures/render/presenter/app-recording.mp4      "screen recording" of the fixture app (scrolling real screenshots)
 *
 *   RENDER_CHROME_PATH=... npx tsx scripts/smoke/make-presenter-fixture.ts
 *
 * Everything is a labelled test fixture; none of it is presented as customer footage.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGsapSource } from "../../packages/compositions/src/node";
import { ffmpegBin, renderProject } from "../../packages/render/src/producer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "fixtures/render/presenter");
const motionSrc = readFileSync(join(out, "motion.mjs"), "utf8").replace(/^export /gm, "");

type Mode = "full" | "person" | "phone";

function html(mode: Mode): string {
  const transparent = mode !== "full";
  const show = (what: "bg" | "person" | "phone") => (what === "bg" ? mode === "full" : what === "person" ? mode !== "phone" : mode !== "person");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=720, height=1280">
<script>${loadGsapSource()}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:720px;height:1280px;overflow:hidden;${transparent ? "background:transparent" : "background:#cbb9a3"}}
#root{position:relative;width:720px;height:1280px;overflow:hidden}
.a{position:absolute}
#room{left:0;top:0;width:720px;height:1280px;background:linear-gradient(180deg,#d8c7b0 0%,#c9b49a 55%,#8f7a64 100%)}
#window{left:-120px;top:-80px;width:560px;height:900px;background:radial-gradient(ellipse at 40% 40%,rgba(255,248,232,.85),rgba(255,248,232,0) 70%);filter:blur(10px)}
.bok{border-radius:50%;filter:blur(18px)}
#shelf{left:470px;top:250px;width:300px;height:22px;background:#7a6450;filter:blur(3px);opacity:.7}
#plant{left:560px;top:120px;width:150px;height:150px;border-radius:50%;background:radial-gradient(circle at 40% 40%,#6f8f5a,#3f5a35);filter:blur(5px)}
#torso{border-radius:200px 200px 40px 40px;background:linear-gradient(100deg,#1b2433 0%,#2b3a52 45%,#1a2230 100%);box-shadow:inset -30px 0 60px rgba(0,0,0,.35)}
#collar{border-radius:0 0 60px 60px;background:#e9e4dc}
#neck{border-radius:26px;background:linear-gradient(90deg,#c88f6f,#dfa985 60%,#c4876a)}
#head{border-radius:50%;background:radial-gradient(ellipse at 40% 38%,#f1c4a2 0%,#dda07e 62%,#c08063 100%);box-shadow:inset -10px -6px 22px rgba(120,60,40,.25)}
#hair{border-radius:70px 70px 30px 30px;background:linear-gradient(180deg,#2c1d14,#3b281c)}
.eye{width:12px;height:9px;border-radius:50%;background:#2a1c16}
.brow{width:26px;height:6px;border-radius:4px;background:#3a2519}
#mouth{width:34px;height:14px;border-bottom:4px solid #9a4b3d;border-radius:0 0 20px 20px}
#ear{width:20px;height:34px;border-radius:50%;background:#d39a78}
#phone{background:#0d0d0f;box-shadow:0 18px 40px rgba(0,0,0,.45),inset 0 0 0 2px #2a2a2e}
#screen{left:8px;top:8px;right:8px;bottom:8px;border-radius:20px;background:linear-gradient(180deg,#f7f7fa,#e9e9ef);overflow:hidden}
.bar{left:12px;right:12px;height:16px;border-radius:6px;background:#d6d6de}
#island{left:50%;top:14px;width:46px;height:12px;margin-left:-23px;border-radius:8px;background:#000}
#arm{height:96px;border-radius:48px;background:linear-gradient(180deg,#2b3a52,#1b2433);transform-origin:0 50%}
#hand{width:96px;height:118px;border-radius:44px 44px 50px 50px;background:radial-gradient(ellipse at 50% 35%,#efbd9a,#d39672)}
.finger{height:22px;border-radius:11px;background:linear-gradient(90deg,#d79a77,#f0c09e)}
#thumb{width:30px;height:68px;border-radius:15px;background:linear-gradient(0deg,#d79a77,#f0c09e);transform:rotate(28deg)}
</style></head><body>
<div id="root" data-composition-id="presenter" data-start="0" data-duration="6" data-width="720" data-height="1280">
${show("bg") ? `<div id="room" class="a"></div><div id="window" class="a"></div><div id="plant" class="a"></div><div id="shelf" class="a"></div>
<div class="a bok" style="left:520px;top:420px;width:120px;height:120px;background:rgba(255,214,150,.55)"></div>
<div class="a bok" style="left:40px;top:640px;width:90px;height:90px;background:rgba(255,236,200,.5)"></div>
<div class="a bok" style="left:610px;top:900px;width:140px;height:140px;background:rgba(255,190,120,.35)"></div>` : ""}
${show("person") ? `<div id="body" class="a" style="left:0;top:0;width:720px;height:1280px"><div id="torso" class="a"></div><div id="neck" class="a"></div><div id="collar" class="a"></div><div id="ear" class="a"></div><div id="head" class="a"><div class="a brow" style="left:28px;top:52px"></div><div class="a brow" style="left:78px;top:50px"></div><div class="a eye" style="left:34px;top:70px"></div><div class="a eye" style="left:84px;top:69px"></div><div id="mouth" class="a" style="left:48px;top:112px"></div></div><div id="hair" class="a"></div></div>` : ""}
${show("phone") ? `<div id="phone" class="a"><div id="screen" class="a"><div class="a bar" style="top:44px;width:60%"></div><div class="a bar" style="top:74px;height:60px;background:#c7c7f5"></div><div class="a bar" style="top:146px"></div><div class="a bar" style="top:170px"></div><div class="a bar" style="top:194px"></div><div class="a bar" style="top:218px;width:50%"></div></div><div id="island" class="a"></div></div>` : ""}
${show("person") ? `<div id="arm" class="a"></div><div id="hand" class="a"></div><div id="f1" class="a finger"></div><div id="f2" class="a finger"></div><div id="f3" class="a finger"></div><div id="thumb" class="a"></div>` : ""}
</div>
<script>
const MODE = ${JSON.stringify(mode)};
${motionSrc}
const $ = (id) => document.getElementById(id);
const set = (id, s) => { const el = $(id); if (el) Object.assign(el.style, s); };
const px = (v) => v.toFixed(2) + "px";
function draw(t) {
  const p = pose(t);
  set("torso", { left: px(p.torso.x), top: px(p.torso.y), width: px(p.torso.w), height: px(p.torso.h) });
  set("neck", { left: px(p.neck.x), top: px(p.neck.y), width: px(p.neck.w), height: px(p.neck.h) });
  set("collar", { left: px(p.neck.x - 34), top: px(p.torso.y - 6), width: px(p.neck.w + 68), height: "54px" });
  set("head", { left: px(p.head.cx - p.head.rx), top: px(p.head.cy - p.head.ry), width: px(p.head.rx * 2), height: px(p.head.ry * 2) });
  set("ear", { left: px(p.head.cx - p.head.rx - 12), top: px(p.head.cy - 10) });
  set("hair", { left: px(p.head.cx - p.head.rx - 6), top: px(p.head.cy - p.head.ry - 18), width: px(p.head.rx * 2 + 12), height: px(p.head.ry * 0.95) });
  set("phone", { left: px(p.phone.x), top: px(p.phone.y), width: px(p.phone.w), height: px(p.phone.h), borderRadius: px(p.phone.r) });
  // Person-only pass: the body is occluded by the phone (a real SAM person mask has this hole);
  // the fingers/hand are drawn after and stay in the mask.
  if (MODE === "person") {
    const ph = p.phone;
    const hole = "M0 0H720V1280H0Z M" + (ph.x + ph.r) + " " + ph.y + "H" + (ph.x + ph.w - ph.r) + "Q" + (ph.x + ph.w) + " " + ph.y + " " + (ph.x + ph.w) + " " + (ph.y + ph.r) + "V" + (ph.y + ph.h - ph.r) + "Q" + (ph.x + ph.w) + " " + (ph.y + ph.h) + " " + (ph.x + ph.w - ph.r) + " " + (ph.y + ph.h) + "H" + (ph.x + ph.r) + "Q" + ph.x + " " + (ph.y + ph.h) + " " + ph.x + " " + (ph.y + ph.h - ph.r) + "V" + (ph.y + ph.r) + "Q" + ph.x + " " + ph.y + " " + (ph.x + ph.r) + " " + ph.y + "Z";
    set("body", { clipPath: "path(evenodd, '" + hole + "')" });
  }
  const dx = p.grip.x - p.elbow.x, dy = p.grip.y - p.elbow.y;
  const len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
  set("arm", { left: px(p.elbow.x), top: px(p.elbow.y - 48), width: px(len), transform: "rotate(" + ang.toFixed(2) + "deg)" });
  set("hand", { left: px(p.grip.x - 56), top: px(p.grip.y - 60) });
  // Fingers wrap over the phone's left edge; thumb over the lower right.
  set("f1", { left: px(p.phone.x - 22), top: px(p.phone.y + p.phone.h * 0.6), width: "40px" });
  set("f2", { left: px(p.phone.x - 24), top: px(p.phone.y + p.phone.h * 0.6 + 27), width: "42px" });
  set("f3", { left: px(p.phone.x - 22), top: px(p.phone.y + p.phone.h * 0.6 + 54), width: "38px" });
  set("thumb", { left: px(p.phone.x + p.phone.w - 20), top: px(p.phone.y + p.phone.h * 0.7) });
}
const proxy = { t: 0 };
const tl = gsap.timeline({ paused: true });
tl.to(proxy, { t: DURATION, duration: DURATION, ease: "none", onUpdate: () => draw(proxy.t) }, 0);
draw(0);
window.__timelines = window.__timelines || {};
window.__timelines["presenter"] = tl;
</script></body></html>`;
}

async function main() {
  mkdirSync(out, { recursive: true });
  const { tracksFor } = (await import(join(out, "motion.mjs"))) as { tracksFor: (o: string) => unknown };
  writeFileSync(join(out, "tracks-person.json"), JSON.stringify(tracksFor("person")));
  writeFileSync(join(out, "tracks-phone.json"), JSON.stringify(tracksFor("phone")));
  const jobs: [Mode, string, "mp4" | "webm"][] = [
    ["full", "presenter.mp4", "mp4"],
    ["person", "person-cutout.webm", "webm"],
    ["phone", "phone-cutout.webm", "webm"],
  ];
  const only = process.argv[2];
  if (only === "html") {
    const dir = mkdtempSync(join(tmpdir(), "presenter-html-"));
    for (const m of ["full", "person", "phone"] as Mode[]) writeFileSync(join(dir, `${m}.html`), html(m));
    console.log(dir);
    return;
  }
  for (const [mode, file, format] of jobs) {
    if (only && only !== mode) continue;
    const dir = mkdtempSync(join(tmpdir(), `presenter-${mode}-`));
    writeFileSync(join(dir, "index.html"), html(mode));
    const t0 = Date.now();
    await renderProject({ projectDir: dir, outputPath: join(out, file), fps: 30, quality: "high", format, onProgress: (p) => void process.stdout.write(`\r${mode} ${p}%   `) });
    console.log(`\n${file} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (!only || only === "recording") {
    // A vertical "screen recording": the two real fixture screenshots stacked and scrolled.
    const shots = join(root, "fixtures/render");
    execFileSync(ffmpegBin(), [
      "-y", "-loglevel", "error",
      "-loop", "1", "-i", join(shots, "screenshot-today.png"),
      "-loop", "1", "-i", join(shots, "screenshot-stats.png"),
      "-filter_complex", "[0:v]scale=590:1278[a];[1:v]scale=590:1278[b];[a][b]vstack=2,crop=590:1278:0:'min(1278,max(0,(t-1.5)*640))',format=yuv420p[v]",
      "-map", "[v]", "-t", "6", "-r", "30", "-c:v", "libx264", "-crf", "20", join(out, "app-recording.mp4"),
    ]);
    console.log("app-recording.mp4");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
