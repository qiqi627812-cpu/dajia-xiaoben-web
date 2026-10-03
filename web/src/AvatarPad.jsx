// AvatarPad.jsx — 手绘头像画板：预设色板 + 任意自选颜色（颜色选择器 + #RRGGBB 校验）
// 真橡皮（destination-out，不是白笔覆盖）；撤销/重做/清空；圆形预览。
// 编辑已有头像：initialSrc 铺底继续画；切色不清画布。
import React, { useRef, useState, useEffect } from "react";

const PALETTE = ["#547D86", "#344C54", "#E6A69C", "#D9A441", "#8FBF9F", "#7EA8C8", "#9B7BB8", "#D9A5A0"];
const PAPER = "#FFFCF4";
const SIZE = 256;
const HEX_RE = /^#([0-9a-fA-F]{6})$/;

export default function AvatarPad({ onChange, initialSrc }) {
  const cvs = useRef(null);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const [tool, setTool] = useState("brush");
  const [color, setColor] = useState(PALETTE[0]);
  const [hexInput, setHexInput] = useState(PALETTE[0]);
  const [hexErr, setHexErr] = useState("");
  const [size, setSize] = useState(12);
  const [preview, setPreview] = useState(null);
  const drawing = useRef(false);
  const last = useRef(null);

  const ctx = () => cvs.current.getContext("2d");

  const paintPaper = () => {
    const c = ctx();
    c.globalCompositeOperation = "source-over";
    c.fillStyle = PAPER;
    c.fillRect(0, 0, SIZE, SIZE);
  };

  useEffect(() => {
    let cancelled = false;
    paintPaper();
    if (initialSrc) {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const c = ctx();
        const s = Math.min(SIZE / img.width, SIZE / img.height);
        const w = img.width * s, h = img.height * s;
        c.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
        emit();
      };
      img.src = initialSrc;
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = () => {
    try {
      const url = cvs.current.toDataURL("image/png");
      setPreview(url);
      onChange && onChange(url);
    } catch { /* noop */ }
  };

  const pos = (e) => {
    const r = cvs.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (SIZE / r.width), y: (e.clientY - r.top) * (SIZE / r.height) };
  };

  const pushUndo = () => {
    undoRef.current.push(ctx().getImageData(0, 0, SIZE, SIZE));
    if (undoRef.current.length > 20) undoRef.current.shift();
    redoRef.current = [];   // 新笔画后，重做分支作废
  };

  const down = (e) => {
    pushUndo();
    drawing.current = true;
    last.current = pos(e);
    stroke(last.current, { x: last.current.x + 0.1, y: last.current.y + 0.1 });
  };
  const move = (e) => {
    if (!drawing.current) return;
    const p = pos(e);
    stroke(last.current, p);
    last.current = p;
  };
  const up = () => { drawing.current = false; emit(); };

  /* 真橡皮：destination-out 直接擦除像素（露出透明，展示层圆底即暖白） */
  const stroke = (a, b) => {
    const c = ctx();
    c.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    c.strokeStyle = tool === "eraser" ? "rgba(0,0,0,1)" : color;
    c.lineWidth = tool === "eraser" ? size * 2.5 : size;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
  };

  const undo = () => {
    const im = undoRef.current.pop();
    if (im) {
      redoRef.current.push(ctx().getImageData(0, 0, SIZE, SIZE));
      ctx().putImageData(im, 0, 0);
      emit();
    }
  };
  const redo = () => {
    const im = redoRef.current.pop();
    if (im) {
      undoRef.current.push(ctx().getImageData(0, 0, SIZE, SIZE));
      ctx().putImageData(im, 0, 0);
      emit();
    }
  };
  const clear = () => {
    pushUndo();
    paintPaper();
    emit();
  };

  /* 自选颜色：颜色选择器即选即生效 */
  const pickColor = (hex) => {
    setColor(hex);
    setHexInput(hex);
    setHexErr("");
    setTool("brush");
  };
  /* #RRGGBB 手输校验 */
  const applyHex = () => {
    const v = hexInput.trim().startsWith("#") ? hexInput.trim() : `#${hexInput.trim()}`;
    if (HEX_RE.test(v)) { pickColor(v); }
    else { setHexErr("格式应为 #RRGGBB（如 #547D86）"); }
  };

  return (
    <div className="avatar-pad">
      <div className="pad-tools">
        {PALETTE.map((c) => (
          <button key={c} type="button"
            className={`swatch${color === c && tool === "brush" ? " on" : ""}`}
            style={{ background: c }} onClick={() => pickColor(c)}
            aria-label={`颜色 ${c}`} />
        ))}
        <label className="custom-color" title="自选颜色">
          <input type="color" value={HEX_RE.test(color) ? color : "#547D86"}
            onChange={(e) => pickColor(e.target.value)} aria-label="自选任意颜色" />
          <span className="cur-color" style={{ background: color }} />
        </label>
        <span className="hex-box">
          <input value={hexInput} onChange={(e) => { setHexInput(e.target.value); setHexErr(""); }}
            onBlur={applyHex} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyHex(); } }}
            placeholder="#RRGGBB" maxLength={7} aria-label="颜色值" />
          {hexErr && <em className="hex-err">{hexErr}</em>}
        </span>
        <button type="button" className={`chip${tool === "eraser" ? " on" : ""}`} onClick={() => setTool("eraser")}>橡皮</button>
        <input type="range" min="4" max="40" value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="笔刷粗细" />
        <button type="button" className="chip" onClick={undo}>撤销</button>
        <button type="button" className="chip" onClick={redo}>重做</button>
        <button type="button" className="chip" onClick={clear}>清空</button>
      </div>
      <div className="pad-stage">
        <canvas ref={cvs} width={SIZE} height={SIZE} className="pad-canvas"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
        {preview && (
          <div className="pad-circle-preview" title="圆形裁切预览">
            <img src={preview} alt="" />
            <span className="hint">圆形预览</span>
          </div>
        )}
      </div>
    </div>
  );
}
