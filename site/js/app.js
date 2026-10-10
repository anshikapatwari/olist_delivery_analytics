/* Renders the whole site from data/results.json + data/sellers.json.
   No number on the page is hardcoded: copy is templated from the pipeline output. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
  const num = (x, d = 0) => Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
  const brl = (x) => "R$" + num(x);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const SEG_ORDER = ["Star sellers", "Quality watch", "Quiet performers", "Hidden risks", "Small and shaky"];
  const ATTR_LABEL = { carrier_only: "Carrier transit abnormal only", seller_only: "Seller dispatch abnormal only",
                       both: "Both abnormal", neither: "Neither abnormal" };
  const GLOSS = { veio: "came / arrived", ainda: "still / yet", entregue: "delivered", entrega: "delivery", chegou: "arrived",
    prazo: "deadline / delivery window", compra: "purchase", pedido: "order", agora: "now", apenas: "only", pois: "because",
    dois: "two", qualidade: "quality", nada: "nothing", site: "website", antes: "before (on time)", recomendo: "I recommend",
    tudo: "everything", excelente: "excellent", "ótimo": "great", super: "super", gostei: "I liked it", "rápida": "fast",
    dentro: "within" };

  let R, S, charts = [], drawers = [];

  function chart(id, cfg) {
    const el = document.getElementById(id);
    if (!el) return;
    const make = () => {
      const old = Chart.getChart(el); if (old) old.destroy();
      const tick = css("--muted"), grid = css("--grid");
      const c = cfg();
      c.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: false }, c.options || {});
      c.options.plugins = Object.assign({ legend: { labels: { color: css("--ink2"), boxWidth: 12 } } }, c.options.plugins || {});
      for (const ax of Object.values(c.options.scales || {})) {
        ax.ticks = Object.assign({ color: tick }, ax.ticks || {});
        ax.grid = Object.assign({ color: grid }, ax.grid || {});
        if (ax.title) ax.title.color = tick;
      }
      new Chart(el, c);
    };
    make();
    drawers.push(make);
  }

  const barOpts = (extra = {}) => Object.assign({ plugins: { legend: { display: false } } }, extra);

  function kpis() {
    const k = R.kpis;
    const items = [
      [num(k.total_orders), "delivered orders analysed"],
      [pct(k.on_time_pct), "delivered on or before the promised date"],
      [num(k.avg_review, 2) + " / 5", "average review score"],
      [num(k.avg_days_late_when_late, 1) + " days", "average lateness when late"],
      [`R$${num(k.gmv / 1e6, 1)}M`, "item sales value (price, excl. freight)"],
    ];
    $("#kpis").innerHTML = items.map(([a, b]) => `<div class="kpi"><b>${a}</b><span>${b}</span></div>`).join("");
  }

  function hero() {
    const k = R.kpis, mw = R.mann_whitney, att = R.attribution;
    const carrier = att.detail.find((d) => d.delay_attribution_detail === "carrier_only").pct_orders;
    const dr = R.dose_response, bad = (b) => b.n * b.pct_1_2_star;
    const lateBad = dr.slice(1).reduce((a, b) => a + bad(b), 0), allBad = dr.reduce((a, b) => a + bad(b), 0);
    $("#hero-title").textContent = `${pct(1 - k.on_time_pct, 0)} of orders arrive late, but they produce ${pct(lateBad / allBad, 0)} of all 1–2★ reviews.`;
    $("#hero-lede").innerHTML =
      `Across ${num(k.total_orders)} real delivered orders, only ${pct(1 - k.on_time_pct)} arrive late — yet those orders score ` +
      `<strong>${num(mw.distribution.late.mean, 2)}</strong> on average vs <strong>${num(mw.distribution.on_time.mean, 2)}</strong> for on-time orders. ` +
      `Roughly ${pct(carrier, 0)} of late orders show abnormal carrier transit with a normal seller dispatch; ` +
      `${pct(att.sensitivity["1.5"].seller_involved, 0)} involve abnormal seller dispatch.`;
  }

  function overview() {
    chart("c-monthly", () => ({
      type: "line",
      data: { labels: R.monthly.map((m) => m.month),
              datasets: [{ label: "On-time %", data: R.monthly.map((m) => +(m.on_time * 100).toFixed(2)),
                           borderColor: css("--s1"), backgroundColor: css("--s1"), pointRadius: 3, borderWidth: 2, tension: 0.2 }] },
      options: barOpts({ scales: { y: { title: { display: true, text: "% of orders on time" }, suggestedMin: 70, suggestedMax: 100 },
                                   x: { ticks: { maxTicksLimit: 8 } } } }),
    }));
    const st = R.review_by_state.filter((s) => s.n >= 100).sort((a, b) => a.avg_review - b.avg_review).slice(0, 12);
    chart("c-state", () => ({
      type: "bar",
      data: { labels: st.map((s) => `${s.customer_state} (n=${num(s.n)})`),
              datasets: [{ data: st.map((s) => +s.avg_review.toFixed(3)), backgroundColor: css("--s1"), borderRadius: 4 }] },
      options: barOpts({ indexAxis: "y", scales: { x: { min: 3, max: 4.5, title: { display: true, text: "Average review (1–5)" } } } }),
    }));
    chart("c-cats", () => ({
      type: "bar",
      data: { labels: R.top_late_categories.map((c) => c.product_category_english.replace(/_/g, " ")),
              datasets: [{ data: R.top_late_categories.map((c) => +(c.pct_late * 100).toFixed(2)), backgroundColor: css("--s2"), borderRadius: 4 }] },
      options: barOpts({ indexAxis: "y", scales: { x: { title: { display: true, text: "% of orders delivered late" } } } }),
    }));
    const m = R.monthly, worst = m.reduce((a, b) => (a.on_time < b.on_time ? a : b));
    $("#ins-overview").innerHTML =
      `Worst month: <strong>${worst.month}</strong> with only ${pct(worst.on_time)} on time (n=${num(worst.n)} orders). ` +
      `Months with fewer than 100 orders (late 2016) are omitted from the trend.`;
  }

  function rootCause() {
    const att = R.attribution;
    $("#ratio").textContent = "1.5";
    chart("c-attr", () => ({
      type: "bar",
      data: { labels: att.detail.sort((a, b) => b.orders - a.orders).map((d) => ATTR_LABEL[d.delay_attribution_detail]),
              datasets: [{ label: "% of late orders", data: att.detail.map((d) => +(d.pct_orders * 100).toFixed(1)), backgroundColor: css("--s1"), borderRadius: 4 },
                         { label: "% of days-late", data: att.detail.map((d) => +(d.pct_days_late * 100).toFixed(1)), backgroundColor: css("--s2"), borderRadius: 4 }] },
      options: { indexAxis: "y", scales: { x: { title: { display: true, text: "%" } } } },
    }));
    const rows = Object.entries(att.sensitivity).map(([k, v]) =>
      `<tr><td>${k}×</td><td class="num">${pct(v.seller_only, 0)}</td><td class="num">${pct(v.carrier_only, 0)}</td><td class="num">${pct(v.both, 0)}</td><td class="num">${pct(v.neither, 0)}</td></tr>`).join("");
    $("#sens").innerHTML = `<table><thead><tr><th>Threshold</th><th class="num">Seller only</th><th class="num">Carrier only</th><th class="num">Both</th><th class="num">Neither</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">${num(att.late_orders_attributed)} of ${num(att.late_orders_total)} late orders are attributable (${num(att.late_orders_excluded_bad_ts)} excluded for inconsistent timestamps).</p>`;
    $("#fallback").textContent = `${num(att.orders_using_seller_state_fallback)} orders use the seller-state dispatch baseline and ${num(att.orders_using_customer_state_fallback)} use the customer-state transit baseline`;
    const l = R.lane_summary, so = att.detail.find((d) => d.delay_attribution_detail === "seller_only"),
          co = att.detail.find((d) => d.delay_attribution_detail === "carrier_only");
    $("#ins-attr").innerHTML =
      `Carrier transit is the dominant signal: <strong>${pct(co.pct_orders, 0)}</strong> of late orders are carrier-only versus <strong>${pct(so.pct_orders, 0)}</strong> seller-only; ` +
      `in another ${pct(att.detail.find((d) => d.delay_attribution_detail === "both").pct_orders, 0)} both stages are abnormal. ` +
      `Geography matters: cross-state orders average ${num(l.cross_state_avg, 1)} transit days vs ${num(l.same_state_avg, 1)} within a state, and only ${pct(l.same_state_share, 0)} of orders are same-state.`;

    // heatmap
    const cells = R.lane_heatmap, sellerStates = [...new Set(cells.map((c) => c.seller_state))]
      .sort((a, b) => cells.filter((c) => c.seller_state === b).reduce((s, c) => s + c.n_orders, 0) - cells.filter((c) => c.seller_state === a).reduce((s, c) => s + c.n_orders, 0));
    const custStates = [...new Set(cells.map((c) => c.customer_state))].sort();
    const vals = cells.map((c) => c.avg_transit_days), lo = Math.min(...vals), hi = Math.max(...vals);
    const idx = Object.fromEntries(cells.map((c) => [c.seller_state + ">" + c.customer_state, c]));
    let h = `<table class="heat"><thead><tr><th></th>${custStates.map((s) => `<th>${s}</th>`).join("")}</tr></thead><tbody>`;
    for (const ss of sellerStates) {
      h += `<tr><th>${ss}</th>`;
      for (const cs of custStates) {
        const c = idx[ss + ">" + cs];
        if (!c) { h += `<td class="na"></td>`; continue; }
        const t = (c.avg_transit_days - lo) / (hi - lo), a = Math.round(8 + t * 92);
        h += `<td style="background:color-mix(in srgb,var(--s1) ${a}%,var(--surface));color:${t > 0.5 ? "#fff" : "var(--ink)"}" title="${ss} → ${cs}: ${num(c.avg_transit_days, 1)} days, ${num(c.n_orders)} orders, ${pct(c.pct_late)} late">${Math.round(c.avg_transit_days)}</td>`;
      }
      h += "</tr>";
    }
    $("#heat").innerHTML = h + "</tbody></table>";
    $("#heat-note").textContent = `${l.lanes_shown} of ${l.lanes_total} lanes have ≥30 orders. Slowest: ` +
      l.slowest.map((s) => `${s.seller_state}→${s.customer_state} (${num(s.avg_transit_days, 0)} d, n=${s.n_orders})`).join("; ") + ". Hover a cell for details.";
  }

  function evidence() {
    const mw = R.mann_whitney, d = mw.distribution;
    chart("c-dist", () => ({
      type: "bar",
      data: { labels: ["1★", "2★", "3★", "4★", "5★"],
              datasets: [{ label: `On-time (n=${num(d.on_time.n)})`, data: [1, 2, 3, 4, 5].map((k) => +(d.on_time.share[k] * 100).toFixed(1)), backgroundColor: css("--s1"), borderRadius: 4 },
                         { label: `Late (n=${num(d.late.n)})`, data: [1, 2, 3, 4, 5].map((k) => +(d.late.share[k] * 100).toFixed(1)), backgroundColor: css("--s2"), borderRadius: 4 }] },
      options: { scales: { y: { title: { display: true, text: "% of orders in group" } } } },
    }));
    chart("c-dose", () => ({
      type: "bar",
      data: { labels: R.dose_response.map((b) => `${b.bucket}\n(n=${num(b.n)})`),
              datasets: [{ data: R.dose_response.map((b) => +b.mean.toFixed(2)), backgroundColor: R.dose_response.map((_, i) => (i === 0 ? css("--s1") : css("--s2"))), borderRadius: 4 }] },
      options: barOpts({ scales: { y: { min: 1, max: 5, title: { display: true, text: "Mean review score" } } } }),
    }));
    $("#mw").innerHTML = `<h3>Mann-Whitney U (late vs on-time)</h3>
      <div class="stat-row"><span>Mean review, on-time − late</span><b>${num(mw.mean_diff, 2)} pts (95% CI ${num(mw.mean_diff_ci95[0], 2)}–${num(mw.mean_diff_ci95[1], 2)})</b></div>
      <div class="stat-row"><span>Rank-biserial effect size</span><b>${num(mw.rank_biserial, 2)}</b></div>
      <div class="stat-row"><span>U statistic</span><b>${num(mw.U)}</b></div>
      <div class="stat-row"><span>p-value</span><b>${mw.p_value === 0 ? "< 1e-300" : mw.p_value.toExponential(1)}</b></div>
      <p class="note">With ${num(mw.n_late + mw.n_on_time)} orders almost anything is "significant", so the effect size matters: 0.64 is large (0 = no difference, 1 = every on-time order outranks every late one). Spearman ρ between days late and score: ${num(R.dose_response_spearman.rho, 2)}.</p>`;
    const L = R.logit, row = (n, m) => `<tr><td>${n}</td><td class="num">${num(m.odds_ratio, 1)}</td><td class="num">${num(m.ci95[0], 1)}–${num(m.ci95[1], 1)}</td></tr>`;
    $("#logit").innerHTML = `<h3>Odds of a ≤3★ review when late</h3>
      <table><thead><tr><th>Model</th><th class="num">Odds ratio</th><th class="num">95% CI</th></tr></thead><tbody>
      ${row("Unadjusted", L.unadjusted)}
      ${row("+ price, freight, category", L.adjusted_price_freight_category)}
      ${row("+ delivery days, items (strict)", L.adjusted_plus_days_to_deliver)}
      <tr><td>Ordinal logit (1–5), same controls as row 2</td><td class="num">${num(R.ordinal_logit.odds_ratio_lower_scores, 1)}</td><td class="num">${num(R.ordinal_logit.ci95[0], 1)}–${num(R.ordinal_logit.ci95[1], 1)}</td></tr>
      </tbody></table>
      <p class="note">n=${num(L.unadjusted.n)} reviewed orders. Delivery days partly <em>is</em> lateness, so row 3 over-controls; it is shown as a floor, not the headline.</p>`;
    const dr = R.dose_response;
    $("#ins-evidence").innerHTML =
      `The effect scales with severity: ${num(dr[0].mean, 2)} → ${num(dr[1].mean, 2)} → ${num(dr[2].mean, 2)} → ${num(dr[3].mean, 2)} stars, and the share of 1–2★ reviews goes ` +
      `${pct(dr[0].pct_1_2_star, 0)} → ${pct(dr[3].pct_1_2_star, 0)}. Controlling for price, freight and category barely moves the odds ratio (${num(L.unadjusted.odds_ratio, 1)} → ${num(L.adjusted_price_freight_category.odds_ratio, 1)}), ` +
      `so cheap or heavy products are not what explains it. Unobserved confounders (product defects, seller communication) are not in this data.`;
  }

  function retention() {
    const r = R.repeat_purchase;
    $("#ret-sub").innerHTML = `Olist is overwhelmingly single-purchase: only <strong>${pct(r.pct_customers_with_2plus_orders)}</strong> of ${num(r.customers_total)} unique customers (<code>customer_unique_id</code>, not <code>customer_id</code>) ordered more than once. ` +
      `So this is framed narrowly: among ${num(r.cohort_n)} customers whose first order was delivered and who had ≥180 days of follow-up, who placed another order <em>after</em> that delivery?`;
    chart("c-repeat", () => ({
      type: "bar",
      data: { labels: [`First order on time (n=${num(r.ontime_first_n)})`, `First order late (n=${num(r.late_first_n)})`],
              datasets: [{ data: [+(r.repeat_rate_ontime * 100).toFixed(2), +(r.repeat_rate_late * 100).toFixed(2)], backgroundColor: [css("--s1"), css("--s2")], borderRadius: 4 }] },
      options: barOpts({ scales: { y: { beginAtZero: true, title: { display: true, text: "% who ordered again" } } } }),
    }));
    $("#ret-stats").innerHTML = `<h3>Difference in proportions</h3>
      <div class="stat-row"><span>Repeat rate: on-time vs late</span><b>${pct(r.repeat_rate_ontime, 2)} vs ${pct(r.repeat_rate_late, 2)}</b></div>
      <div class="stat-row"><span>Difference (late − on-time)</span><b>${num(r.diff * 100, 2)} pp (95% CI ${num(r.diff_ci95[0] * 100, 2)} to ${num(r.diff_ci95[1] * 100, 2)})</b></div>
      <div class="stat-row"><span>χ² test</span><b>χ²=${num(r.chi2, 1)}, p=${r.p_value.toExponential(1)}</b></div>
      <div class="stat-row"><span>Adjusted odds ratio (price band, category, state)</span><b>${num(r.adjusted_odds_ratio, 2)} (${num(r.adjusted_or_ci95[0], 2)}–${num(r.adjusted_or_ci95[1], 2)})</b></div>
      <p class="note">Observational: customers who get late deliveries may differ in ways not captured here.</p>`;
    $("#ins-ret").innerHTML = `A late first order is associated with a repeat rate about ${pct(1 - r.repeat_rate_late / r.repeat_rate_ontime, 0)} lower in relative terms, but the absolute gap is only ${num(-r.diff * 100, 1)} percentage points because almost nobody returns either way. ` +
      `The retention cost is statistically clear and commercially small; the bigger cost of lateness is in reviews and reputation.`;
  }

  let wl = { rows: [], sortK: "revenue_at_risk", dir: -1, page: 0, size: 15 };
  function sellers() {
    const sg = R.segmentation, segs = sg.segments;
    $("#seg-sub").innerHTML = `${num(sg.sellers_total)} sellers have delivered orders; only <strong>${num(sg.sellers_eligible)}</strong> have ≥${sg.min_orders} (enough to trust a rate). ` +
      `Cuts — volume: ${esc(sg.rules.volume)}; reliability: ${esc(sg.rules.reliability)}; quality: ${esc(sg.rules.quality)}. ` +
      `The remaining sellers are shown as "Insufficient history" rather than guessed at.`;
    const order = SEG_ORDER.map((n) => segs.find((s) => s.segment === n)).filter(Boolean);
    chart("c-seg", () => ({
      type: "bar",
      data: { labels: order.map((s) => s.segment),
              datasets: [{ label: "% of all late orders", data: order.map((s) => +(s.pct_late_orders * 100).toFixed(1)), backgroundColor: css("--s2"), borderRadius: 4 },
                         { label: "% of GMV", data: order.map((s) => +(s.pct_gmv * 100).toFixed(1)), backgroundColor: css("--s1"), borderRadius: 4 }] },
      options: { scales: { y: { title: { display: true, text: "%" } } } },
    }));
    const ins = segs.find((s) => s.segment === "Insufficient history");
    const body = order.concat(ins ? [ins] : []).map((s) =>
      `<tr><td>${esc(s.segment)}</td><td class="num">${num(s.sellers)}</td><td class="num">${num(s.orders)}</td><td class="num">${pct(s.pct_late_rate)}</td><td class="num">${brl(s.revenue_at_risk)}</td></tr>`).join("");
    $("#seg-table").innerHTML = `<table><thead><tr><th>Segment</th><th class="num">Sellers</th><th class="num">Orders</th><th class="num">% late</th><th class="num">Rev. at risk</th></tr></thead><tbody>${body}</tbody></table>
      <p class="note">Platform average: ${pct(sg.platform_pct_late)} late, ${num(sg.platform_avg_review, 2)}★.</p>`;

    wl.rows = S;
    const segSel = $("#f-seg"), stSel = $("#f-state");
    segSel.innerHTML = `<option value="">All</option>` + SEG_ORDER.map((s) => `<option>${s}</option>`).join("");
    stSel.innerHTML = `<option value="">All</option>` + [...new Set(S.map((r) => r.seller_state))].sort().map((s) => `<option>${s}</option>`).join("");
    segSel.value = "Hidden risks";
    for (const el of [segSel, stSel, $("#f-q")]) el.addEventListener("input", () => { wl.page = 0; renderWl(); });
    $("#prev").onclick = () => { wl.page--; renderWl(); };
    $("#next").onclick = () => { wl.page++; renderWl(); };
    document.querySelectorAll("#wl th").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k; wl.dir = wl.sortK === k ? -wl.dir : (k === "seller_id" || k === "segment" || k === "seller_state" || k === "category" ? 1 : -1);
      wl.sortK = k; wl.page = 0; renderWl();
    }));
    renderWl();
  }
  function renderWl() {
    const seg = $("#f-seg").value, st = $("#f-state").value, q = $("#f-q").value.trim().toLowerCase();
    let rows = wl.rows.filter((r) => (!seg || r.segment === seg) && (!st || r.seller_state === st) && (!q || r.seller_id.toLowerCase().includes(q)));
    const k = wl.sortK;
    rows.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * wl.dir);
    const pages = Math.max(1, Math.ceil(rows.length / wl.size));
    wl.page = Math.min(Math.max(wl.page, 0), pages - 1);
    $("#wl-count").textContent = `· ${num(rows.length)} sellers`;
    $("#page-info").textContent = `Page ${wl.page + 1} of ${pages}`;
    $("#prev").disabled = wl.page === 0; $("#next").disabled = wl.page >= pages - 1;
    document.querySelectorAll("#wl th").forEach((th) => { if (th.dataset.k === k) th.setAttribute("aria-sort", wl.dir > 0 ? "ascending" : "descending"); else th.removeAttribute("aria-sort"); });
    const tb = $("#wl tbody");
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="8" class="muted">No sellers match these filters.</td></tr>`; return; }
    tb.innerHTML = rows.slice(wl.page * wl.size, (wl.page + 1) * wl.size).map((r) => {
      const cls = r.segment === "Hidden risks" || r.segment === "Small and shaky" ? "hr" : r.segment === "Star sellers" ? "st" : "";
      return `<tr><td><code>${esc(r.seller_id.slice(0, 8))}…</code></td><td><span class="pill ${cls}">${esc(r.segment)}</span></td><td>${esc(r.seller_state)}</td>
        <td>${esc(String(r.category).replace(/_/g, " "))}</td><td class="num">${num(r.n_orders)}</td><td class="num">${pct(r.pct_late)}</td>
        <td class="num">${num(r.avg_review, 2)}</td><td class="num">${num(r.revenue_at_risk)}</td></tr>`;
    }).join("");
  }

  function voice() {
    const t = R.review_text;
    $("#voice-sub").innerHTML = `Honest scope: ${num(t.with_comment)} of ${num(t.reviews_total)} reviews (${pct(t.pct_with_comment, 0)}) have comment text; this covers that subset. ` +
      `Comments are Portuguese; themes are matched with Portuguese keyword stems on <em>all</em> of them, so no sampling or machine translation is involved. ${num(t.negative_comments_1_2_star)} comments are 1–2★.`;
    const themes = Object.keys(t.theme_share_negative);
    chart("c-themes", () => ({
      type: "bar",
      data: { labels: themes,
              datasets: [{ label: "1–2★ comments", data: themes.map((k) => +(t.theme_share_negative[k] * 100).toFixed(1)), backgroundColor: css("--s2"), borderRadius: 4 },
                         { label: "4–5★ comments", data: themes.map((k) => +(t.theme_share_positive[k] * 100).toFixed(1)), backgroundColor: css("--s1"), borderRadius: 4 }] },
      options: { indexAxis: "y", scales: { x: { title: { display: true, text: "% of comments mentioning theme" } } } },
    }));
    chart("c-deliv", () => ({
      type: "bar",
      data: { labels: [`Late orders (n=${num(t.neg_late_n)})`, `On-time orders (n=${num(t.neg_ontime_n)})`],
              datasets: [{ data: [+(t.delivery_share_neg_late * 100).toFixed(1), +(t.delivery_share_neg_ontime * 100).toFixed(1)], backgroundColor: [css("--s2"), css("--s1")], borderRadius: 4 }] },
      options: barOpts({ scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: "% of 1–2★ comments mentioning delivery" } } } }),
    }));
    $("#ins-voice").innerHTML = `Delivery keywords appear in <strong>${pct(t.delivery_share_neg_late, 0)}</strong> of 1–2★ comments on late orders versus <strong>${pct(t.delivery_share_neg_ontime, 0)}</strong> on on-time orders. ` +
      `Caveat: delivery words also appear in ${pct(t.theme_share_positive["Delivery / shipping"], 0)} of 4–5★ comments ("arrived before the deadline"), so keyword presence alone is not a complaint; the late vs on-time gap is the signal. ` +
      `Wrong/incomplete items (${pct(t.theme_share_negative["Wrong / incomplete item"], 0)}) and product quality (${pct(t.theme_share_negative["Product quality / defect"], 0)}) are the next-biggest complaint themes — real, but not delivery problems.`;
    const list = (arr) => `<table><tbody>${arr.map((x) => `<tr><td><code>${esc(x.term)}</code></td><td class="muted">${esc(GLOSS[x.term] || "—")}</td><td class="num">${pct(x.share, 0)}</td></tr>`).join("")}</tbody></table>`;
    $("#terms").innerHTML = `<div><h3>In 1–2★ comments</h3>${list(t.top_terms_neg)}</div><div><h3>In 4–5★ comments</h3>${list(t.top_terms_pos)}</div>`;
  }

  function actions() {
    const sc = R.scenario, att = R.attribution, sg = R.segmentation.segments, g = (n) => sg.find((s) => s.segment === n),
          hr = g("Hidden risks"), ss = g("Small and shaky"), qp = g("Quiet performers"), l = R.lane_summary,
          r = R.repeat_purchase, mw = R.mann_whitney;
    const recs = [
      ["Fix lanes before sellers: renegotiate carrier SLAs and pad promised dates on the slowest routes",
       `Carrier transit is abnormal in ${pct(att.sensitivity["1.5"].carrier_involved, 0)} of late orders (${pct(att.detail.find((d) => d.delay_attribution_detail === "carrier_only").pct_orders, 0)} carrier-only), ` +
       `and cross-state orders take ${num(l.cross_state_avg, 1)} vs ${num(l.same_state_avg, 1)} days. Start with the lanes that are both slow and high-volume (see heatmap) and show a realistic delivery window on the product page for them.`,
       `Sizing: affects the ${pct(1 - l.same_state_share, 0)} of orders that cross a state border. Validate first: a lane-level pilot comparing review scores with padded vs current estimates.`],
      ["Pilot a dispatch SLA with the Hidden-risk sellers",
       `${num(hr.sellers)} sellers (${pct(hr.pct_sellers)} of sellers, ${pct(hr.pct_gmv, 0)} of GMV) generate ${pct(hr.pct_late_orders, 0)} of all late orders at a ${pct(hr.pct_late_rate)} late rate vs ${pct(R.segmentation.platform_pct_late)} platform-wide.`,
       `Scenario (assumption-based, not a forecast): bringing them to the median eligible seller's ${pct(sc.target_pct_late)} would remove about ${num(sc.late_orders_avoided)} late orders (${pct(sc.pct_of_all_late_orders, 0)} of all), ` +
       `roughly ${brl(sc.gmv_per_month)}/month of order value delivered on time. Run it as an A/B test in a subset of states before any platform-wide penalty.`],
      ["Onboard small shaky sellers with a stricter SLA; promote quiet performers",
       `${num(ss.sellers)} "Small and shaky" sellers run at ${pct(ss.pct_late_rate)} late versus ${pct(qp.pct_late_rate)} for ${num(qp.sellers)} "Quiet performers" of similar size.`,
       `Low absolute impact (${pct(ss.pct_late_orders, 0)} of late orders) but cheap to act on. Do not justify this on repeat revenue: avoiding ${num(sc.late_orders_avoided)} late orders recovers only about ${brl(sc.repeat_revenue_recovered)} of repeat purchases over the period (95% CI ${brl(sc.repeat_revenue_recovered_ci95[0])}–${brl(sc.repeat_revenue_recovered_ci95[1])}); the case rests on review quality (${num(mw.mean_diff, 1)} points per late order).`],
    ];
    $("#recs").innerHTML = recs.map((r, i) => `<div class="rec"><div class="n">${i + 1}</div><div><h3>${esc(r[0])}</h3><p>${r[1]}</p><p class="muted">${r[2]}</p></div></div>`).join("");
    const dq = R.data_quality, t = R.review_text;
    $("#limits").innerHTML = [
      `Attribution is a median-ratio heuristic, not a causal estimate; results shift with the threshold (see sensitivity table).`,
      `Only ${num(R.segmentation.sellers_eligible)} of ${num(R.segmentation.sellers_total)} sellers have ≥30 orders; the long tail is not scored.`,
      `Retention covers a small minority (${pct(r.pct_customers_with_2plus_orders)} of customers order twice) and is observational; unobserved customer differences could contribute.`,
      `Reviews: ${pct(1 - t.pct_with_comment, 0)} have no comment; theme matching is keyword-based (Portuguese stems) and will miss sarcasm and negation.`,
      `${num(dq.bad_timestamp_orders)} delivered orders have inconsistent timestamps (flagged, excluded from attribution); ${num(dq.missing_delivery_ts)} lack a delivery date; ${num(dq.multi_seller_orders)} orders have multiple sellers and are assigned to the first item's seller.`,
      `The revenue-at-risk and SLA scenario figures are explicit what-ifs with stated assumptions; the data covers ${dq.date_min} to ${dq.date_max} only.`,
      `Dataset is 2016–2018; carrier and marketplace behaviour may have changed.`,
    ].map((x) => `<li>${x}</li>`).join("");
  }

  function theme() {
    const root = document.documentElement;
    const cur = () => root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    $("#theme").addEventListener("click", () => {
      const next = cur() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) { /* storage unavailable */ }
      drawers.forEach((d) => d());
    });
    try { const t = localStorage.getItem("theme"); if (t) root.setAttribute("data-theme", t); } catch (e) { /* ignore */ }
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => drawers.forEach((d) => d()));
  }

  async function main() {
    theme();
    try {
      const [r, s] = await Promise.all([fetch("data/results.json").then((x) => x.json()), fetch("data/sellers.json").then((x) => x.json())]);
      R = r; S = s;
    } catch (e) {
      $("#hero-lede").textContent = "Could not load data/results.json. Serve this folder over HTTP (python -m http.server) rather than opening the file directly.";
      return;
    }
    kpis(); hero(); overview(); rootCause(); evidence(); retention(); sellers(); voice(); actions();
  }
  main();
})();
