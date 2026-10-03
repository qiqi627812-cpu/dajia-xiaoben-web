// Avatar.jsx — 统一圆形头像（全站唯一展示组件）
// 圆形裁切、暖白底、细白边、轻阴影；内容保持比例（object-fit: cover）；
// 无头像显示昵称首字。原始绘画数据保留在 member.avatar，编辑不受影响。
import React from "react";

export default function Avatar({ name, src, size = 48, className = "", me = false, title }) {
  const px = `${size}px`;
  const label = (name || "?").slice(0, 1);
  return (
    <span className={`dj-avatar${me ? " is-me" : ""}${className ? ` ${className}` : ""}`}
      style={{ width: px, height: px }}
      title={title || name || undefined}
      aria-hidden="true">
      {src
        ? <img src={src} alt="" draggable="false" />
        : <span className="dj-ava-init">{label}</span>}
      {me && <span className="dj-ava-me">我</span>}
    </span>
  );
}
