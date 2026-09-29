// Minimal Chrome DevTools Protocol client for driving the editor window like a
// user would: real mouse clicks, typing, key presses and screenshots.
import * as fs from "fs";
import * as path from "path";

export class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    };
  }

  static async connect(port: string): Promise<Cdp> {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[];
    const page = targets.find((t) => t.type === "page" && /workbench/.test(t.url)) ?? targets.find((t) => t.type === "page");
    if (!page) throw new Error("No workbench page found over CDP");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    return new Cdp(ws);
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result.value as T;
  }

  async click(x: number, y: number): Promise<void> {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }

  async typeText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async press(key: "Enter" | "Escape"): Promise<void> {
    const code = key === "Enter" ? 13 : 27;
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", key, text: "\r", unmodifiedText: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  }

  async screenshot(dir: string, name: string): Promise<string> {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  close(): void {
    this.ws.close();
  }
}
