// 极简 DOM 助手：只用 textContent 写文本（不用 innerHTML 拼用户输入），保持默认安全的习惯。
// kids 既可传数组也可用可变参数，统一 flat 后追加。
export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export const clear = (node) => {
  node.textContent = "";
  return node;
};

export const mount = (parent, ...kids) => {
  clear(parent);
  parent.append(...kids.flat().filter(Boolean));
  return parent;
};

export const card = (title, ...kids) => el("section", { class: "card" }, [title && el("h4", { text: title }), ...kids.flat()]);
export const badge = (ok, textOk, textBad) => el("span", { class: `badge ${ok ? "ok" : "bad"}`, text: ok ? textOk : textBad });
export const btn = (label, onclick, primary = false) => el("button", { class: primary ? "primary" : "act", text: label, onclick });
export const note = (text) => el("p", { class: "note", text });
export const list = (items) => el("ul", {}, items.map((t) => (t instanceof Node ? t : el("li", { text: String(t) }))));
export const pre = (text) => el("pre", { text });
export const hashText = (text) => el("span", { class: "hash", text });
export const input = (value = "", placeholder = "") => el("input", { type: "text", value, placeholder });
export const textarea = (value = "", placeholder = "") => el("textarea", { placeholder }, value);
export const label = (text) => el("label", { text });
export const h3 = (text) => el("h3", { text });
export const lead = (text) => el("p", { class: "lead", text });

export const kv = (pairs) =>
  el(
    "div",
    { class: "kv" },
    pairs.flatMap(([k, v]) => [el("b", { text: k }), v instanceof Node ? v : el("span", { class: "hash", text: String(v) })])
  );

const cell = (value) => {
  if (value instanceof Node) return el("td", {}, [value]);
  const text = String(value ?? "");
  return el("td", { class: text.length > 34 ? "hash" : undefined, text });
};

export const table = (headers, rows) =>
  el(
    "table",
    {},
    el("thead", {}, el("tr", {}, headers.map((t) => el("th", { text: t })))),
    rows.map((r) => (r instanceof Node ? r : el("tr", {}, r.map(cell))))
  );
