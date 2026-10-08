// 简约主题（奶油白 / 暖深色）的首屏：一面能拨动的罗盘。
//
// ★ 出处：设计小样 `luopan.final-20261004.html`。宝宝 10/7 点名的 lp3_light / lp3_dark
//   两张图就是这份小样渲出来的，配色、布局、字号一律以它为准（#9128）。
//   这一版相对小样只做三件**必要**的事，别的都照抄：
//
//   ① **拆成 head / 罗盘 / footer 三段**，不再是「一整块 390×844 的 SVG + slice」。
//      小样是 390×844 的定稿画布，用 slice 铺满时只要视口一矮就上下对半裁 ——
//      390×740 会切掉「日子」那行，390×640 连「早上好」和底部三格一起切掉。
//      星空首屏当初踩过同一个坑，解法也一样：顶、底移出整屏 SVG 进普通文档流，
//      中间那段单独 preserveAspectRatio="xMidYMid meet" 按剩余高度整体缩放。
//      ★ 390×844 这一档三段相加正好 180 + 500 + 164 = 844，罗盘圆心落在 430，
//        和定稿画布逐像素重合；矮屏才靠 clamp 收 head/footer、罗盘按剩余高度缩。
//
//   ② 外圈房间的手势换成全站复用的 orbit-controller（拖动 / 惯性 / 点击阈值 /
//      切后台与出屏暂停 / 清理），小样里那套手写的拖动逻辑不再单独维护一份。
//
//   ③ 私人信息一律从设置读：印章字取 assistantName 首字（没填就退回「伴」），
//      纪念日取 companion_since，日期行才带得出「第 N 天」。
//
// ★ 刻意**没有**照搬的三处，免得以后有人以为是漏了：
//   · 小样的 `?ring=seal|slip` 两套备选样式不做 —— 那是给选型看的三选一，
//     图里定的是卦牌（gua）这套，生产页只留定稿。
//   · 小样的点一下弹 toast 只是为了在没有路由的静态页里给个反馈；
//     进了 App 就是真的进房间，所以房间和天池都挂 data-action="tab"。
//   · 「此刻」「天气」两格不写示例值，和星空首屏同源：从 settings 读
//     （currentStatus / assistantStatus、weather），没有数据就整格不显示。
//     节气那格是本机算的，任何时候都有值。

export const LUOPAN_VIEW = String.raw`
<!-- 纸纹：单独一层铺满整屏。小样把它画在整块画布上，这里也照做 ——
     段与段之间的接缝不落在纸上，颜色对不上就不会有一道横线。 -->
<svg class="luopan-grain" viewBox="0 0 390 844" preserveAspectRatio="none" aria-hidden="true" focusable="false">
  <defs>
    <filter id="lpGrain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7"/>
      <feColorMatrix values="0 0 0 0 .35  0 0 0 0 .28  0 0 0 0 .2  0 0 0 .07 0"/>
    </filter>
  </defs>
  <!-- 比画布大一圈：矮屏时画布被 meet 缩进去，纸纹仍然铺到边，不会在两侧露白。 -->
  <rect x="-40" y="-40" width="470" height="924" filter="url(#lpGrain)"/>
</svg>

<!-- 顶部：日子 / 问候 / 宜忌。进普通文档流，safe-area 由 .luopan-stage 让出来。 -->
<header class="luopan-head">
  <svg class="luopan-svg" viewBox="0 0 390 180" preserveAspectRatio="xMidYMid meet" aria-label="日期与问候">
    <g transform="translate(195,64)" text-anchor="middle" class="serif">
      <text id="lpDate" font-size="10.5" letter-spacing="4" fill="var(--lp-ink-soft)"></text>
      <line x1="-120" y1="14" x2="-30" y2="14" stroke="var(--lp-line-soft)" stroke-width=".5"/>
      <line x1="30" y1="14" x2="120" y2="14" stroke="var(--lp-line-soft)" stroke-width=".5"/>
      <g transform="translate(0,14)">
        <rect x="-5" y="-5" width="10" height="10" transform="rotate(45)" fill="none" stroke="var(--lp-line)" stroke-width=".6"/>
        <circle r="1.4" fill="var(--lp-line)"/>
      </g>
    </g>
    <text id="lpHello" x="195" y="122" text-anchor="middle" class="serif" font-size="26" fill="var(--lp-ink)" letter-spacing="7"></text>
    <!-- 朱红小印：字只装一个字，取 assistantName 的首字 -->
    <g transform="translate(272,104)" aria-hidden="true">
      <rect x="-9" y="-9" width="18" height="18" rx="1.5" fill="var(--lp-red)" opacity=".9"/>
      <rect x="-7.4" y="-7.4" width="14.8" height="14.8" rx="1" fill="none" stroke="var(--lp-bg)" stroke-width=".5" opacity=".7"/>
      <text id="lpSeal" y="4.2" text-anchor="middle" class="serif" font-size="11" fill="var(--lp-bg)"></text>
    </g>
    <text id="lpAlmanac" x="195" y="150" text-anchor="middle" class="serif" font-size="11.5" fill="var(--lp-ink-soft)" letter-spacing="3"></text>
  </svg>
</header>

<!-- 罗盘：独占剩余高度，按剩余高度整体缩放。圆心就是本 SVG 的坐标原点，
     于是 orbit-controller 的 center 是 (0,0) —— 少一层「画布坐标 → 视图坐标」的换算。 -->
<div class="luopan-viewport">
<svg id="lpDial" class="luopan-svg" viewBox="-195 -245 390 500" preserveAspectRatio="xMidYMid meet" aria-label="罗盘首页">
  <defs>
    <radialGradient id="lpPool" cx=".45" cy=".42" r=".7">
      <stop offset="0" stop-color="var(--lp-bg2)"/><stop offset="1" stop-color="var(--lp-bg)"/>
    </radialGradient>
  </defs>
  <g id="lpDialBody">
    <!-- 天心十道 -->
    <g stroke="var(--lp-red)" stroke-width=".5" opacity=".55">
      <line x1="-138" y1="0" x2="138" y2="0"/><line x1="0" y1="-138" x2="0" y2="138"/>
    </g>
    <!-- 最外一层：二十四节气，当下的节气点朱红 -->
    <circle r="120" fill="var(--lp-bg)" opacity=".55"/>
    <circle r="120" fill="none" stroke="var(--lp-line)" stroke-width=".9"/>
    <circle r="117.5" fill="none" stroke="var(--lp-line-soft)" stroke-width=".35"/>
    <g id="lpTerms"></g>
    <circle r="101" fill="none" stroke="var(--lp-line-soft)" stroke-width=".4"/>
    <circle r="96" fill="url(#lpPool)"/>
    <circle r="96" fill="none" stroke="var(--lp-line)" stroke-width="1"/>
    <circle r="93" fill="none" stroke="var(--lp-line-soft)" stroke-width=".4"/>
    <g id="lpDeg"></g>
    <circle r="80" fill="none" stroke="var(--lp-line-soft)" stroke-width=".45"/>
    <g id="lpMountains"></g>
    <circle r="64" fill="none" stroke="var(--lp-line-soft)" stroke-width=".45"/>
    <g id="lpGua"></g>
    <circle r="38" fill="none" stroke="var(--lp-line-soft)" stroke-width=".45"/>
    <circle r="35" fill="none" stroke="var(--lp-line)" stroke-width=".7"/>
    <!-- 天池：中心的指针，点它进私聊 -->
    <g id="lpCenter" class="luopan-hit" data-action="tab" data-tab="chat" role="button" tabindex="0" aria-label="进入私聊">
      <circle r="34" fill="transparent"/>
      <g id="lpRipples" stroke="var(--lp-line-faint)" fill="none" stroke-width=".35">
        <circle r="12"/><circle r="19"/><circle r="26"/>
      </g>
      <g id="lpNeedle" class="luopan-needle">
        <path d="M0,-27 L3.2,0 L0,27 L-3.2,0Z" fill="var(--lp-needle-dark)"/>
        <path d="M0,-27 L3.2,0 L-3.2,0Z" fill="var(--lp-red)"/>
        <path d="M0,-27 L0,27" stroke="var(--lp-bg)" stroke-width=".3" opacity=".6"/>
        <circle r="3" fill="var(--lp-bg)" stroke="var(--lp-line)" stroke-width=".7"/>
        <circle r="1" fill="var(--lp-line)"/>
      </g>
    </g>
    <text y="154" text-anchor="middle" class="serif" font-size="12.5" fill="var(--lp-ink)" letter-spacing="6">私 聊</text>
    <text y="168" text-anchor="middle" class="serif" font-size="8.5" fill="var(--lp-ink-faint)" letter-spacing="3">天 池</text>

    <!-- 外圈入口：一卦一个房间，会慢慢转（由 orbit-controller 摆位） -->
    <ellipse rx="158" ry="204" fill="none" stroke="var(--lp-line-soft)" stroke-width=".7" stroke-dasharray="1 5" stroke-linecap="round"/>
    <g id="lpRing"></g>
  </g>
</svg>
</div>

<!-- 底部：今天的三件小事。同样进文档流，由 CSS 给它固定高度。 -->
<footer class="luopan-footer">
  <svg class="luopan-svg" viewBox="0 0 390 164" preserveAspectRatio="xMidYMid meet" aria-label="此刻、天气与节气">
    <g transform="translate(195,20)">
      <line x1="-160" y1="0" x2="-14" y2="0" stroke="var(--lp-line-soft)" stroke-width=".5"/>
      <line x1="14" y1="0" x2="160" y2="0" stroke="var(--lp-line-soft)" stroke-width=".5"/>
      <rect x="-4" y="-4" width="8" height="8" transform="rotate(45)" fill="none" stroke="var(--lp-line)" stroke-width=".6"/>
      <g class="serif" text-anchor="middle">
        <g id="lpInfoNow" transform="translate(-118,32)" class="luopan-info">
          <text font-size="9" letter-spacing="3" fill="var(--lp-ink-faint)">此 刻</text>
          <text y="21" font-size="13" letter-spacing="1.5" fill="var(--lp-ink)" class="luopan-info-title"></text>
          <text y="38" font-size="10" letter-spacing="1" fill="var(--lp-ink-soft)" class="luopan-info-detail"></text>
        </g>
        <line id="lpDiv1" x1="-58" y1="20" x2="-58" y2="76" stroke="var(--lp-line-faint)" stroke-width=".5"/>
        <g id="lpInfoWeather" transform="translate(0,32)" class="luopan-info">
          <text font-size="9" letter-spacing="3" fill="var(--lp-ink-faint)">天 气</text>
          <text y="21" font-size="13" letter-spacing="1.5" fill="var(--lp-ink)" class="luopan-info-title"></text>
          <text y="38" font-size="10" letter-spacing="1" fill="var(--lp-ink-soft)" class="luopan-info-detail"></text>
        </g>
        <line id="lpDiv2" x1="58" y1="20" x2="58" y2="76" stroke="var(--lp-line-faint)" stroke-width=".5"/>
        <g id="lpInfoTerm" transform="translate(118,32)" class="luopan-info">
          <text font-size="9" letter-spacing="3" fill="var(--lp-ink-faint)">节 气</text>
          <text y="21" font-size="13" letter-spacing="1.5" fill="var(--lp-ink)" class="luopan-info-title" id="lpTermName"></text>
          <text y="38" font-size="10" letter-spacing="1" fill="var(--lp-ink-soft)" class="luopan-info-detail" id="lpTermNext"></text>
        </g>
      </g>
      <text y="124" text-anchor="middle" class="serif" font-size="11" fill="var(--lp-ink-faint)" letter-spacing="4">转一转罗盘，挑一个房间</text>
    </g>
  </svg>
</footer>`;

export function renderLuopanHome() {
  return `<div class="home-view luopan-home"><div class="luopan-stage">${LUOPAN_VIEW}</div></div>`;
}
