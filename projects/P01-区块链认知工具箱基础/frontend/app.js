import overview from "./views/overview.js";
import hashView from "./views/hash.js";
import chainView from "./views/chain.js";
import merkleView from "./views/merkle.js";
import signView from "./views/signature.js";
import powView from "./views/pow.js";

const views = [overview, hashView, chainView, merkleView, signView, powView];
const nav = document.getElementById("nav");
const stage = document.getElementById("view");

function renderNav(activeId) {
  const frag = document.createDocumentFragment();
  for (const view of views) {
    const button = document.createElement("button");
    button.textContent = view.title;
    button.className = view.id === activeId ? "active" : "";
    button.addEventListener("click", () => {
      location.hash = `#/${view.id}`;
    });
    frag.append(button);
  }
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "每个 Demo 右下角标注它支撑的商业合规模块（M0–M5）。";
  frag.append(hint);
  nav.replaceChildren(frag);
}

async function show(id) {
  const view = views.find((v) => v.id === id) ?? views[0];
  renderNav(view.id);
  stage.textContent = "";
  await view.render(stage);
  document.title = `P01 · ${view.title}`;
}

const envInfo = document.getElementById("envInfo");
envInfo.textContent = [
  `安全上下文：${window.isSecureContext ? "是（crypto.subtle 可用）" : "否！请用 http://127.0.0.1 打开"}`,
  `Node ${navigator.userAgent.match(/Node\/[\d.]+/)?.[0] ?? "浏览器"}`,
].join(" ｜ ");

window.addEventListener("hashchange", () => show((location.hash.replace(/^#\/?/, "") || "overview")));
show((location.hash.replace(/^#\/?/, "") || "overview"));
