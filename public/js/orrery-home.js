const ORRERY_VIEW = String.raw`<svg class="orrery-defs" viewBox="0 0 1 1" aria-hidden="true" focusable="false">
  <defs id="orreryDefs">
    <!-- 四芒小星 -->
    <path id="spark" d="M0,-1 C.12,-.12 .12,-.12 1,0 C.12,.12 .12,.12 0,1 C-.12,.12 -.12,.12 -1,0 C-.12,-.12 -.12,-.12 0,-1Z"/>
    <pattern id="hatch" width="2.6" height="2.6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <line x1="0" y1="0" x2="0" y2="2.6" stroke="#d9bf8a" stroke-width=".55" opacity=".75"/>
    </pattern>
    <pattern id="hatchBlue" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
      <line x1="0" y1="0" x2="0" y2="2.4" stroke="#a9b6d8" stroke-width=".5" opacity=".7"/>
    </pattern>
    <radialGradient id="lamp">
      <stop offset="0" stop-color="#ffe2a8" stop-opacity=".95"/>
      <stop offset="1" stop-color="#ffcf7a" stop-opacity="0"/>
    </radialGradient>
    <pattern id="hatchFine" width="1.1" height="1.1" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
      <line x1="0" y1="0" x2="0" y2="1.1" stroke="#a9b6d8" stroke-width=".22" opacity=".8"/>
    </pattern>
    <pattern id="hatchGoldFine" width="1.25" height="1.25" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <line x1="0" y1="0" x2="0" y2="1.25" stroke="#e2c993" stroke-width=".32"/>
    </pattern>
    <pattern id="hatchCross" width="1.4" height="1.4" patternUnits="userSpaceOnUse" patternTransform="rotate(60)">
      <line x1="0" y1="0" x2="0" y2="1.4" stroke="#c5cfee" stroke-width=".22" opacity=".8"/>
    </pattern>
    <radialGradient id="moonBody" cx=".4" cy=".38" r=".7"><stop offset="0" stop-color="#4a4889"/><stop offset=".65" stop-color="#2c2560"/><stop offset="1" stop-color="#1a1442"/></radialGradient>
    <radialGradient id="moonGold" cx=".36" cy=".34" r=".8"><stop offset="0" stop-color="#e2c993" stop-opacity=".42"/><stop offset=".7" stop-color="#b89e6c" stop-opacity=".24"/><stop offset="1" stop-color="#8a7448" stop-opacity=".14"/></radialGradient>
    <pattern id="hatchMare" width=".7" height=".7" patternUnits="userSpaceOnUse" patternTransform="rotate(-40)">
      <line x1="0" y1="0" x2="0" y2=".7" stroke="#6e5532" stroke-width=".12"/>
    </pattern>
    <radialGradient id="halo-warm"><stop offset="0" stop-color="#f1e2c4" stop-opacity=".6"/><stop offset=".35" stop-color="#e3cfa8" stop-opacity=".16"/><stop offset="1" stop-color="#e3cfa8" stop-opacity="0"/></radialGradient>
    <radialGradient id="halo-gold"><stop offset="0" stop-color="#f3dca8" stop-opacity=".6"/><stop offset=".35" stop-color="#d9bf8a" stop-opacity=".18"/><stop offset="1" stop-color="#d9bf8a" stop-opacity="0"/></radialGradient>
    <radialGradient id="halo-blue"><stop offset="0" stop-color="#dfe6ff" stop-opacity=".6"/><stop offset=".35" stop-color="#b3bfe2" stop-opacity=".18"/><stop offset="1" stop-color="#b3bfe2" stop-opacity="0"/></radialGradient>
    <radialGradient id="moonLit" cx=".38" cy=".36" r=".75"><stop offset="0" stop-color="#fbeecb"/><stop offset=".7" stop-color="#e2c993"/><stop offset="1" stop-color="#c7aa70"/></radialGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation=".45"/></filter>
    <filter id="soft2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.4"/></filter>
    <radialGradient id="limb" cx=".46" cy=".44" r=".56"><stop offset=".55" stop-color="#0d0922" stop-opacity="0"/><stop offset="1" stop-color="#0d0922" stop-opacity=".5"/></radialGradient>
    <filter id="neb" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.5"/></filter>
    <clipPath id="moonClip"><circle r="40"/></clipPath>
    <mask id="offMoon" maskUnits="userSpaceOnUse" x="-100" y="-100" width="200" height="200">
      <rect x="-100" y="-100" width="200" height="200" fill="#fff"/><circle r="40.5" fill="#000"/>
    </mask>
    <mask id="crescent">
      <circle cx="0" cy="0" r="40" fill="#fff"/>
      <circle cx="17" cy="-9" r="36" fill="#000"/>
    </mask>
  </defs>
</svg>

<!-- 顶部进入正常文档流；浏览器地址栏和 App 导航压缩视口时不会再被 slice 裁掉。 -->
<header class="orrery-head">
  <svg class="orrery-phases" viewBox="0 0 390 88" preserveAspectRatio="xMidYMid meet" aria-label="今日月相">
  <g id="phases" transform="translate(195,27)"></g>
  <g transform="translate(195,66)">
    <line x1="-150" y1="0" x2="-18" y2="0" stroke="var(--gold-soft)" stroke-width=".55"/>
    <line x1="18" y1="0" x2="150" y2="0" stroke="var(--gold-soft)" stroke-width=".55"/>
    <circle cx="-150" r="1.4" fill="var(--gold)"/><circle cx="150" r="1.4" fill="var(--gold)"/>
    <circle cx="-24" r=".9" fill="var(--gold)"/><circle cx="24" r=".9" fill="var(--gold)"/>
    <path d="M-9,0 L0,-4 L9,0 L0,4 Z" fill="none" stroke="var(--gold)" stroke-width=".6"/>
    <use href="#spark" transform="scale(3.6)" fill="var(--gold)"/>
  </g>
  </svg>
  <div id="hello" class="orrery-hello">你好</div>
  <div id="daysLine" class="orrery-days">我们在一起的第 <span id="days">0</span> 天</div>
</header>

<!-- 中间星盘独占一个 meet SVG，按剩余高度整体缩放。 -->
<div class="orrery-viewport">
<svg id="s" class="orrery-svg" data-orrery-svg viewBox="0 180 390 496" preserveAspectRatio="xMidYMid meet" aria-label="星盘首页">
  <g id="dust"></g>

  <!-- 星盘 -->
  <g id="dial" transform="translate(195,438)">
    <circle r="92" fill="none" stroke="var(--gold-soft)" stroke-width=".6"/>
    <circle r="85" fill="none" stroke="var(--gold)" stroke-width="4.5" stroke-dasharray=".8 3.8" opacity=".7"/>
    <circle r="79" fill="none" stroke="var(--gold-soft)" stroke-width=".4"/>
    <circle r="69" fill="none" stroke="var(--gold-soft)" stroke-width=".3"/>
    <path id="txtRing" d="M0,-73.2 A73.2,73.2 0 1 1 -0.01,-73.2" fill="none"/>
    <text font-size="5.2" fill="rgba(217,191,138,.62)" class="serif"><textPath href="#txtRing" id="ringText" textLength="452" lengthAdjust="spacing"></textPath></text>
    <ellipse rx="148" ry="190" fill="none" stroke="rgba(217,191,138,.14)" stroke-width=".5" stroke-dasharray="1 5"/>
    <g id="ticks"></g>
    <g id="rays"></g>

    <!-- 中心：月亮和我们的小岛，点它进私聊 -->
    <g id="center"><g transform="scale(.86)">
      <circle r="84" fill="transparent"/>
      <!-- 轨道后半圈（被月亮挡住） -->
      <g transform="translate(0,-4) rotate(-28)">
        <ellipse rx="76" ry="24" fill="none" stroke="var(--gold)" stroke-width=".4" stroke-dasharray=".8 2.4" opacity=".4"/>
      </g>
      <circle cy="-4" r="56" fill="url(#halo-gold)" opacity=".22" id="glow2"/>
      <g transform="translate(0,-4) scale(.95)">
        <circle r="40" fill="#150f30"/>
        <g clip-path="url(#moonClip)" id="moonTex"></g>
        <circle r="40" fill="none" stroke="var(--gold)" stroke-width=".7"/>
        <circle r="43.5" fill="none" stroke="var(--gold)" stroke-width=".3" opacity=".4"/>
      </g>
      <!-- 轨道前半圈：经过月面的那一段断开，不读成土星环 -->
      <g transform="translate(0,-4) rotate(-28)">
        <path d="M-76,0 A76,24 0 0 0 76,0" fill="none" stroke="var(--gold)" stroke-width=".55" opacity=".8" mask="url(#offMoon)"/>
        <g id="trail"></g>
        <g id="sat">
          <circle r="9" fill="url(#lamp)" id="glow"/>
          <use href="#spark" transform="scale(4.2)" fill="#ffe2a8"/>
          <circle r="1.1" fill="#fffaf0"/>
        </g>
      </g>
      <text y="72" text-anchor="middle" class="serif" font-size="13" fill="var(--gold)" letter-spacing="5">私 聊</text>
    </g></g>

    <!-- 外圈的星座（会转） -->
    <g id="ring"></g>
    <!-- 独立命中层放在最上面，避免后插入的星座节点截走中心点击。 -->
    <circle class="orrery-center" r="72" fill="transparent" data-action="tab" data-tab="chat" role="button" tabindex="0" aria-label="进入私聊"/>
  </g>

</svg>
</div>

<!-- 底部同样进入正常文档流，并由 CSS grid 处理 1/2/3 栏。 -->
<footer class="orrery-footer">
  <div class="orrery-footer-rule" aria-hidden="true"><i></i></div>
  <div class="orrery-info-grid">
    <section id="orreryInfoNow" class="orrery-info">
      <span class="orrery-info-label">此 刻</span>
      <strong class="orrery-info-title" id="nowWho"></strong>
      <span class="orrery-info-detail"></span>
    </section>
    <section id="orreryInfoWeather" class="orrery-info">
      <span class="orrery-info-label">天 气</span>
      <strong class="orrery-info-title"></strong>
      <span class="orrery-info-detail"></span>
    </section>
    <section id="orreryInfoMoon" class="orrery-info">
      <span class="orrery-info-label">今 夜</span>
      <strong class="orrery-info-title" id="moonName">月相</strong>
      <span class="orrery-info-detail" id="moonAge">月龄</span>
    </section>
  </div>
  <p class="orrery-invite">拨一拨星盘，挑一个房间</p>
</footer>`;

export function renderOrreryHome() {
  return `<div class="home-view orrery-home"><div class="orrery-stage">${ORRERY_VIEW}</div></div>`;
}
