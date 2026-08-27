/* ── APP STATE ──────────────────────────────────────────────────── */
const state = {
  editingDecision: null,
  expandedEvidence: new Set(),
  actionsTaken: new Map(),
  aqExpanded: new Set(),
  // split view
  splitView: false,
  queueFilter: 'needs_review',  // 'needs_review' | 'acted'
  currentSelectedId: null,
};

/* ── LABEL MAPS ─────────────────────────────────────────────────── */
const ACTION_LABELS = {
  extract_quotation:        'Extract quotation',
  reconcile_revised_figure: 'Reconcile revised price',
  normalise_unit_price:     'Normalise unit price',
  match_to_catalogue:       'Match to catalogue',
  flag_expired_document:    'Flag expired document',
  flag_price_outlier:       'Flag price outlier',
  send_clarification_email: 'Send clarification email',
  recommend_award_split:    'Recommend award split',
  redact_pii:               'Redact PII',
  flag_lead_time_conflict:  'Flag lead-time conflict',
  dispute_extraction:       'Dispute extraction',
};

const AGENT_LABELS = {
  'extraction-agent':    'Extraction',
  'critic-agent':        'Critic',
  'catalogue-agent':     'Catalogue',
  'normalisation-agent': 'Normalisation',
  'compliance-agent':    'Compliance',
  'sourcing-agent':      'Sourcing',
  'comms-agent':         'Comms',
};

const FIELD_LABELS = {
  supplier:             'Supplier',
  product_name:         'Product name',
  inn:                  'INN (generic name)',
  price_per_pack:       'Price per pack',
  price_per_unit:       'Price per unit',
  pack_size:            'Pack size',
  currency:             'Currency',
  line_items:           'Line items extracted',
  assumed_pack_size:    'Assumed pack size',
  superseded_value:     'Previous (superseded) price',
  incoming_presentation:'Incoming presentation',
  candidate_match:      'Best catalogue match',
  match_type:           'Match type',
  alternative:          'Alternative action',
  document:             'Document',
  expiry_date:          'Expiry date',
  offers_suspended:     'Offers suspended',
  recipient:            'Recipient',
  subject:              'Email subject',
  body_excerpt:         'Email body (excerpt)',
  sent:                 'Sent',
  demand_units:         'Demand (units)',
  estimated_saving_vs_benchmark_usd: 'Estimated saving vs benchmark',
  source:               'Source document',
  retained:             'Retained content',
  buyer:                'Buyer',
  required_delivery_by: 'Required delivery by',
  quoted_lead_time_days:'Quoted lead time (days)',
  projected_delivery:   'Projected delivery date',
  field:                'Disputed field',
  extraction_agent_value:'Extraction agent says',
  critic_agent_value:   'Critic agent says',
  example_line:         'Example line item',
  redactions:           'Redactions applied',
  options_generated:    'Options generated',
};

/* ── HELPERS ────────────────────────────────────────────────────── */
function confidenceInfo(score) {
  if (score === 0 || score === null || score === undefined)
    return { label: 'Unknown',           cls: 'conf-unknown',  plain: "The agent has no idea" };
  if (score < 0.45)
    return { label: 'Uncertain',         cls: 'conf-low',      plain: "The agent is not confident" };
  if (score < 0.65)
    return { label: 'Low confidence',    cls: 'conf-partial',  plain: "More likely right than wrong, but uncertain" };
  if (score < 0.80)
    return { label: 'Moderate',          cls: 'conf-moderate', plain: "Reasonably confident but worth checking" };
  if (score < 0.93)
    return { label: 'Confident',         cls: 'conf-good',     plain: "Agent is confident — spot check recommended" };
  return   { label: 'High confidence',   cls: 'conf-high',     plain: "Agent is very confident" };
}

function confBadge(score) {
  const c = confidenceInfo(score);
  return `<span class="conf-badge ${c.cls}" title="${c.plain}">${c.label}</span>`;
}

function riskBadge(risk) {
  const map = {
    high:   `<span class="badge badge-risk-high">High risk</span>`,
    medium: `<span class="badge badge-risk-medium">Medium risk</span>`,
    low:    `<span class="badge badge-risk-low">Low risk</span>`,
  };
  return map[risk] || '';
}

function statusBadge(status) {
  const map = {
    pending_review: `<span class="badge badge-pending">⏸ Pending review</span>`,
    executed:       `<span class="badge badge-executed">⚡ Executed</span>`,
    auto_approved:  `<span class="badge badge-auto">✓ Auto-approved</span>`,
    failed:         `<span class="badge badge-failed">✕ Failed</span>`,
  };
  return map[status] || `<span class="badge">${status}</span>`;
}

function agentBadge(agent) {
  const label = AGENT_LABELS[agent] || agent;
  return `<span class="badge-agent agent-${agent}">${label}</span>`;
}

function fmtMoney(n) {
  if (!n && n !== 0) return '—';
  if (n === 0) return '$0';
  return '$' + n.toLocaleString('en-US');
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fieldLabel(key) {
  return FIELD_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* ── PRIORITY SCORING (risk × reversibility × exposure) ─────────── */
function getUpstreamErrors(d) {
  if (!d.evidence) return [];
  return d.evidence
    .filter(ev => ev.source && ev.source.match(/^D-\d+$/))
    .map(ev => DECISIONS.find(u => u.id === ev.source))
    .filter(u => u && u.known_error === true);
}

function priorityScore(d) {
  const riskScore = { high: 3, medium: 2, low: 1 }[d.risk] || 1;
  const irrevBonus = (d.reversible === false) ? 2 : 0;
  const expScore = d.financial_exposure_usd > 100000 ? 3
                 : d.financial_exposure_usd >  10000 ? 2
                 : d.financial_exposure_usd >      0 ? 1 : 0;
  const errorBonus    = d.known_error ? 10 : 0;
  const upstreamBonus = getUpstreamErrors(d).length > 0 ? 8 : 0;
  return riskScore * 2 + irrevBonus + expScore + errorBonus + upstreamBonus;
}

/* ── WORKLIST ───────────────────────────────────────────────────── */
function renderAutonomyKey() {
  return '<div class="autonomy-key">' +
    '<div class="ak-title">Autonomy boundary</div>' +
    '<div class="ak-item"><span class="ak-dot ak-dot-pending"></span><span><strong>Pending review</strong> — human required</span></div>' +
    '<div class="ak-item"><span class="ak-dot ak-dot-auto"></span><span><strong>Auto-approved</strong> — pre-set rule</span></div>' +
    '<div class="ak-item"><span class="ak-dot ak-dot-exec"></span><span><strong>Executed</strong> — agent acted alone</span></div>' +
    '<div class="ak-item"><span class="ak-dot ak-dot-error"></span><span><strong>Known error</strong> — post-hoc flag</span></div>' +
  '</div>';
}

/* ── DECISION DETAIL: MAIN ──────────────────────────────────────── */
function renderDecisionDetail(id) {
  const d = DECISIONS.find(x => x.id === id);
  if (!d) return `<p style="padding:32px;color:var(--text-muted)">Decision "${id}" not found. <a href="#/worklist">Back to queue</a></p>`;

  const upstreamErrors = getUpstreamErrors(d);
  const conf = confidenceInfo(d.confidence);
  const actionTaken = state.actionsTaken.get(id);

  return `
    <div class="detail-page">

      ${!state.splitView ? `
      <div class="detail-nav">
        <a href="#/worklist" class="back-link">← Back to queue</a>
        <span class="breadcrumb">${d.id} · ${AGENT_LABELS[d.agent] || d.agent} · ${ACTION_LABELS[d.action_type] || d.action_type}</span>
      </div>` : ''}

      ${actionTaken ? renderAuditBanner(actionTaken) : ''}
      ${upstreamErrors.length ? renderUpstreamBanner(d, upstreamErrors) : ''}
      ${d.known_error          ? renderKnownErrorBanner(d) : ''}
      ${d.status === 'failed'  ? renderFailedBanner(d) : ''}
      ${d.status === 'executed' && !d.known_error ? renderExecutedNote(d) : ''}
      ${d.status === 'auto_approved' ? renderAutoNote(d) : ''}

      <div class="detail-header">
        <div class="detail-title-row">
          <h1 class="detail-id">${d.id}</h1>
          ${agentBadge(d.agent)}
          <span class="detail-action-type">${ACTION_LABELS[d.action_type] || d.action_type}</span>
        </div>
        <div class="detail-meta">
          ${statusBadge(d.status)}
          ${riskBadge(d.risk)}
          ${d.reversible === false
            ? `<span class="badge badge-irreversible">⚠ Irreversible action</span>`
            : `<span class="badge badge-reversible">Reversible</span>`}
          ${d.financial_exposure_usd > 0
            ? `<span class="badge badge-exposure">${fmtMoney(d.financial_exposure_usd)} exposure</span>`
            : ''}
          <span class="detail-timestamp">Aug 17, 2026 · ${fmtTime(d.timestamp)}</span>
        </div>
      </div>

      ${!state.splitView ? renderActionBar(d) : ''}

      <div id="detail-body-${id}" class="detail-body">

        <div class="detail-section">
          <div class="section-title">Summary</div>
          <p class="detail-summary">${d.summary}</p>
        </div>

        <div class="detail-section">
          <div class="section-title">Proposed values</div>
          ${renderProposedValues(d)}
        </div>

        <div class="detail-section">
          <div class="section-title">Evidence</div>
          <div class="evidence-list" id="ev-list-${id}">
            ${(d.evidence || []).map((ev, i) => renderEvidenceItem(ev, id, i, upstreamErrors)).join('')}
          </div>
        </div>

        <div class="detail-section">
          <div class="section-title">Agent's reasoning</div>
          <div class="reasoning-block">${d.reasoning}</div>
          ${d.downstream_effect ? `
            <div class="downstream-block mt-12">
              <span class="downstream-icon">→</span>
              <span><strong>Downstream:</strong> ${d.downstream_effect}</span>
            </div>` : ''}
        </div>

        <div class="overall-confidence">
          <span class="conf-label">Overall confidence:</span>
          ${confBadge(d.confidence)}
          <span class="conf-pct">${d.confidence === 0 ? 'n/a' : Math.round(d.confidence * 100) + '%'}</span>
          <span class="conf-acted-note">
            ${d.status === 'executed'      ? '— agent acted on this confidence, without review' :
              d.status === 'auto_approved' ? '— acted under auto-approval rule' :
              d.status === 'pending_review'? '— agent paused here, waiting on you' :
              d.status === 'failed'        ? '— extraction failed' : ''}
          </span>
          ${d.known_error
            ? `<span style="margin-left:auto;font-size:12px;color:var(--high);font-weight:600;">⚠ This confidence score was misleading — the decision was wrong</span>`
            : ''}
        </div>

        ${d.agent_question ? renderAgentQuestion(d) : ''}

      </div>


    </div>
  `;
}

/* ── BANNERS ────────────────────────────────────────────────────── */
function renderUpstreamBanner(d, errors) {
  const e = errors[0];
  return `
    <div class="banner banner-upstream">
      <div class="banner-title">⚠ This decision's inputs include a flagged error</div>
      <div class="banner-body">
        This recommendation relies on <strong>${e.id}</strong> (${AGENT_LABELS[e.agent] || e.agent}) which has been flagged as incorrect after execution.
        Specifically: <em>${e.summary}</em><br>
        The exclusion of Cipla Ltd in this decision may be invalid — it was priced out using a wrong unit calculation.
      </div>
      <div class="banner-actions">
        <a href="#/error-trace/${d.id}" class="btn btn-sm btn-trace">View error trace →</a>
        <a href="#/decision/${e.id}" class="btn btn-sm btn-escalate">Inspect ${e.id}</a>
      </div>
    </div>
  `;
}

function renderKnownErrorBanner(d) {
  return `
    <div class="banner banner-error">
      <div class="banner-title">⛔ Known error — executed without review</div>
      <div class="banner-body">
        This decision was executed autonomously with ${Math.round(d.confidence * 100)}% confidence — but it is flagged as incorrect.
        The high confidence score did not reflect the actual risk of the wrong assumption.
        <br><strong>How it surfaced:</strong> ${d.how_it_surfaced}
      </div>
      <div class="banner-actions">
        <a href="#/error-trace/D-1058" class="btn btn-sm btn-trace">View downstream impact →</a>
        <button class="btn btn-sm btn-correct" onclick="showCorrectModal()">Correct this decision</button>
      </div>
    </div>
  `;
}

function renderFailedBanner(d) {
  return `
    <div class="banner banner-failed">
      <div class="banner-title">✕ Agent could not complete this step</div>
      <div class="banner-body">
        The agent produced no output. Manual intervention required.
        ${d.agent_question ? `<br><strong>Agent note:</strong> "${d.agent_question}"` : ''}
      </div>
    </div>
  `;
}

function renderExecutedNote(d) {
  return `
    <div style="padding:10px 16px;background:var(--s-exec-bg);border:1px solid var(--border-mid);border-radius:6px;margin-bottom:10px;font-size:13px;color:var(--s-exec);display:flex;align-items:center;gap:8px;">
      <span>⚡</span>
      <span><strong>Executed without review</strong> — the agent acted autonomously. You are reviewing this after the fact.</span>
    </div>
  `;
}

function renderAutoNote(d) {
  return `
    <div style="padding:10px 16px;background:var(--s-auto-bg);border:1px solid var(--low-border);border-radius:6px;margin-bottom:10px;font-size:13px;color:var(--s-auto);display:flex;align-items:center;gap:8px;">
      <span>✓</span>
      <span><strong>Auto-approved</strong> — the agent acted under a pre-authorised rule (below risk/value threshold). Post-hoc review is optional.</span>
    </div>
  `;
}

function renderAuditBanner(entry) {
  return `
    <div class="audit-banner">
      <span class="audit-banner-icon">✓</span>
      <span><strong>Action logged:</strong> ${entry.action} by CL at ${entry.timestamp}.${entry.note ? ' ' + entry.note : ''}</span>
    </div>
  `;
}

/* ── PROPOSED VALUES ────────────────────────────────────────────── */
function renderProposedValues(d) {
  if (!d.proposed_values) {
    return `<div class="value-unknown" style="padding:8px 0;"><span class="unknown-dot"></span> No values extracted — agent failed to produce output.</div>`;
  }

  // Special-cased decisions
  if (d.id === 'D-1058') return renderAwardSplitValues(d);
  if (d.id === 'D-1070') return renderConflictValues(d);
  if (d.id === 'D-1042') return renderNormalisationError(d);
  if (d.id === 'D-1053') return renderPriceOutlierValues(d);
  if (d.id === 'D-1044') return renderCatalogueMatchValues(d);
  if (d.id === 'D-1064') return renderLeadTimeConflictValues(d);

  // Generic renderer with optional per-field confidence
  return renderGenericValues(d);
}

function renderGenericValues(d) {
  const pv = d.proposed_values;
  const fc = d.field_confidence || {};
  const rows = flattenForTable(pv, fc, d.id);
  return `
    <table class="values-table" id="values-table-${d.id}">
      <tbody>${rows}</tbody>
    </table>
  `;
}

function flattenForTable(pv, fc, did) {
  let html = '';
  for (const [key, val] of Object.entries(pv)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      html += `<tr><td class="field-group-header" colspan="3">${fieldLabel(key)}</td></tr>`;
      for (const [k2, v2] of Object.entries(val)) {
        html += renderFieldRow(k2, v2, fc[k2], did, '  ');
      }
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        // skip empty
      } else if (val.every(item => typeof item === 'string')) {
        html += renderFieldRow(key, val.join('; '), fc[key], did, '');
      } else if (val.every(item => typeof item === 'object' && item !== null)) {
        // Array of objects — format each as "count type" or key: val pairs
        const formatted = val.map(item => {
          if ('count' in item && 'type' in item) return `${item.count} ${item.type.replace(/_/g,' ')}(s)`;
          return Object.entries(item).map(([k,v]) => `${v}`).join(' ');
        }).join('; ');
        html += renderFieldRow(key, formatted, fc[key], did, '');
      }
    } else {
      html += renderFieldRow(key, val, fc[key], did, '');
    }
  }
  return html;
}

function renderFieldRow(key, val, confScore, did, prefix) {
  const isMissing = val === null || val === undefined;
  const isUnknown = confScore === 0 || (isMissing && confScore !== undefined);
  const label = fieldLabel(key);
  const conf  = confScore !== undefined ? confidenceInfo(confScore) : null;

  let valueHtml;
  if (isUnknown && isMissing) {
    valueHtml = `
      <span class="fv-display value-unknown">
        <span class="unknown-dot"></span>
        Agent couldn't determine this — manual input required
      </span>
      <input class="fv-input" type="text" value="" placeholder="Enter value…" data-field="${key}">
    `;
  } else {
    const displayVal = isMissing ? '—' : (typeof val === 'boolean' ? (val ? 'Yes' : 'No') : String(val));
    valueHtml = `
      <span class="fv-display">${displayVal}</span>
      <input class="fv-input" type="text" value="${isMissing ? '' : String(val).replace(/"/g, '&quot;')}" data-field="${key}">
    `;
  }

  const confCell = conf
    ? `<span class="conf-badge ${conf.cls}" title="${conf.plain}">${conf.label}</span>`
    : '';

  return `
    <tr class="field-row ${isUnknown ? 'field-row-critical' : ''}">
      <td class="field-key">${prefix}${label}</td>
      <td class="field-val">${valueHtml}</td>
      <td class="field-conf-cell">${confCell}</td>
    </tr>
  `;
}

/* ── AWARD SPLIT (D-1058) ───────────────────────────────────────── */
function renderAwardSplitValues(d) {
  const pv = d.proposed_values;
  const split = pv.recommended_split || [];
  const excluded = pv.excluded || [];

  const splitRows = split.map(s => `
    <tr>
      <td style="font-weight:600;">${s.supplier}</td>
      <td>
        <div class="split-share-bar">
          <div class="split-bar-bg"><div class="split-bar-fill" style="width:${s.share_pct}%"></div></div>
          <span class="split-pct">${s.share_pct}%</span>
        </div>
      </td>
      <td class="text-mono">$${s.price_per_unit}</td>
      <td>${s.lead_time_days} days</td>
    </tr>
  `).join('');

  const excludedRows = excluded.map(ex => `
    <div class="excluded-row">
      <span class="excluded-supplier">${ex.supplier}</span>
      <div>
        <div class="excluded-reason">${ex.reason}</div>
        ${ex.note === 'derived from D-1042' ? `
          <div class="excluded-error-note">
            ⚠ This price derives from <strong>D-1042</strong>, which is flagged as incorrect.
            The actual price is likely ~$0.34/unit — which would make Cipla competitive.
          </div>` : ''}
      </div>
    </div>
  `).join('');

  return `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
      <div class="demand-chip">1,400,000 units demand</div>
      <div class="saving-chip">Est. saving ${fmtMoney(pv.estimated_saving_vs_benchmark_usd)} vs benchmark</div>
    </div>

    <div class="section-title" style="margin-bottom:8px;">Recommended split</div>
    <table class="split-table" style="margin-bottom:16px;">
      <thead>
        <tr>
          <th>Supplier</th>
          <th>Share</th>
          <th>Price / unit</th>
          <th>Lead time</th>
        </tr>
      </thead>
      <tbody>${splitRows}</tbody>
    </table>

    ${excluded.length ? `
      <div class="section-title" style="margin-bottom:8px;">Excluded from shortlist</div>
      <div class="excluded-table">
        <div class="excluded-header">⚠ Excluded — agent's stated reason</div>
        ${excludedRows}
      </div>` : ''}
  `;
}

/* ── AGENT CONFLICT (D-1070) ────────────────────────────────────── */
function renderConflictValues(d) {
  const pv = d.proposed_values;
  const ev = d.evidence || [];
  const evExt  = ev[0] || {};
  const evCrit = ev[1] || {};

  return `
    <div style="margin-bottom:12px;font-size:13px;color:var(--text-muted);">
      Disputed field: <strong style="color:var(--text)">${fieldLabel(pv.field)}</strong>
      &nbsp;·&nbsp; Supplier: <strong style="color:var(--text)">${pv.supplier}</strong>
      &nbsp;·&nbsp; Price on document: <strong style="color:var(--text)" class="text-mono">$${pv.price_per_pack}</strong>
    </div>

    <div class="conflict-grid">
      <div class="conflict-panel conflict-panel-extraction">
        <div class="conflict-panel-header">Extraction agent says</div>
        <div class="conflict-panel-body">
          <div class="conflict-value">${pv.extraction_agent_value}</div>
          <div class="conflict-quote">${evExt.quote || '(no direct quote)'}</div>
          <div class="conflict-locator">${evExt.source} — ${evExt.locator}</div>
          <div style="margin-top:10px;font-size:12px;color:var(--text-muted);">
            Weights the currency symbol adjacent to the figure.
          </div>
        </div>
      </div>
      <div class="conflict-panel conflict-panel-critic">
        <div class="conflict-panel-header">Critic agent says</div>
        <div class="conflict-panel-body">
          <div class="conflict-value">${pv.critic_agent_value}</div>
          <div class="conflict-quote">${evCrit.quote || '(no direct quote)'}</div>
          <div class="conflict-locator">${evCrit.source} — ${evCrit.locator}</div>
          <div style="margin-top:10px;font-size:12px;color:var(--text-muted);">
            Weights the explicit written statement in the footer.
          </div>
        </div>
      </div>
    </div>
    <div class="conflict-impact">
      <div class="conflict-impact-title">Impact of getting this wrong</div>
      USD vs EUR at ~1.09 exchange rate → ~9% price error on ${fmtMoney(d.financial_exposure_usd)} of potential exposure.
      This error would silently propagate into every comparison involving ${pv.supplier}.
    </div>
  `;
}

/* ── NORMALISATION ERROR (D-1042) ───────────────────────────────── */
function renderNormalisationError(d) {
  const pv = d.proposed_values;
  return `
    <div class="normalisation-error-grid">
      <div class="norm-cell norm-cell-wrong">
        <div class="norm-cell-label">⛔ What the agent calculated (wrong)</div>
        <div class="norm-row"><span class="norm-row-key">Assumed pack size</span><span class="norm-row-val norm-val-wrong">1 inhaler</span></div>
        <div class="norm-row"><span class="norm-row-key">Price per pack</span><span class="norm-row-val text-mono">$${pv.price_per_pack}</span></div>
        <div class="norm-row"><span class="norm-row-key">Price per unit</span><span class="norm-row-val norm-val-wrong text-mono">$${pv.price_per_unit}</span></div>
        <div class="norm-row"><span class="norm-row-key">Product</span><span class="norm-row-val" style="font-size:12px;">${pv.product_name}</span></div>
      </div>
      <div class="norm-cell norm-cell-correct">
        <div class="norm-cell-label">✓ What it should have been</div>
        <div class="norm-row"><span class="norm-row-key">Actual pack size</span><span class="norm-row-val norm-val-correct">10 inhalers/carton</span></div>
        <div class="norm-row"><span class="norm-row-key">Price per pack</span><span class="norm-row-val text-mono">$${pv.price_per_pack}</span></div>
        <div class="norm-row"><span class="norm-row-val norm-val-correct text-mono">$0.34</span><span class="norm-row-key" style="text-align:right;">Correct price per unit</span></div>
        <div class="norm-row" style="padding-top:6px;"><span style="font-size:12px;color:var(--low);">Document states "carton of 10 inhalers" as minimum sellable unit — not read by agent.</span></div>
      </div>
    </div>
    <div style="margin-top:12px;padding:10px 14px;background:var(--high-bg);border:1px solid var(--high-border);border-radius:6px;font-size:13px;color:var(--text);">
      <strong style="color:var(--high);">Effect:</strong> Cipla appeared 10× more expensive than competitors and was silently excluded from the award shortlist in D-1058. No human was asked before this was executed.
    </div>
  `;
}

/* ── PRICE OUTLIER (D-1053) ─────────────────────────────────────── */
function renderPriceOutlierValues(d) {
  const pv = d.proposed_values;
  return `
    <div class="price-comparison" style="margin-bottom:14px;">
      <div class="price-cell">
        <span class="price-label">Submitted price</span>
        <span class="price-value text-mono">$${pv.price_per_unit}</span>
        <span class="price-sub">per unit · ${pv.supplier}</span>
        <span class="price-sub" style="margin-top:4px;">${pv.product_name}</span>
      </div>
      <div class="price-cell">
        <span class="price-label">12-month benchmark</span>
        <span class="price-value price-value-bench text-mono">$${pv.benchmark_price_per_unit}</span>
        <span class="price-sub">median across 9 suppliers</span>
      </div>
      <div class="price-delta">
        <div class="price-delta-num">${pv.delta_pct}%</div>
        <div class="price-delta-label">below benchmark</div>
      </div>
    </div>
    <div class="price-flags">
      <div class="price-flag"><span class="price-flag-icon">→</span> The extraction was confirmed clean by the critic-agent against the source PDF.</div>
      <div class="price-flag"><span class="price-flag-icon">→</span> Possible explanations: volume commitment discount, currency upstream error, or supplier data-entry mistake.</div>
      <div class="price-flag"><span class="price-flag-icon">→</span> If accepted and later disputed: demand could be aggregated at an undeliverable price, ${fmtMoney(d.financial_exposure_usd)} at risk.</div>
    </div>
  `;
}

/* ── CATALOGUE MATCH (D-1044) ───────────────────────────────────── */
function renderCatalogueMatchValues(d) {
  const pv = d.proposed_values;
  const fc = d.field_confidence || {};

  const confRows = Object.entries(fc).map(([k, v]) => `
    <div class="cat-conf-row">
      <span class="cat-conf-label">${fieldLabel(k)}</span>
      ${confBadge(v)}
    </div>
  `).join('');

  return `
    <div class="catalogue-comparison">
      <div class="cat-products">
        <div class="cat-product">
          <div class="cat-product-label">Incoming (supplier)</div>
          <div class="cat-product-name">${pv.incoming_presentation}</div>
        </div>
        <div class="cat-vs">vs</div>
        <div class="cat-product">
          <div class="cat-product-label">Best catalogue match</div>
          <div class="cat-product-name">${pv.candidate_match}</div>
        </div>
      </div>
      <div class="cat-conflict-field">
        <span style="color:var(--high);font-weight:600;">⚠</span>
        <span>Strength differs: <strong>125mg/5ml</strong> vs <strong>120mg/5ml</strong> — near-equivalent but not the same registered presentation. If merged, they compete on the same line, making the comparison unreliable.</span>
      </div>
      <div>
        <div class="section-title" style="margin-bottom:8px;">Field-level confidence</div>
        <div class="cat-field-conf-grid">${confRows}</div>
      </div>
      <div class="options-block">
        <div class="options-title">Options</div>
        <div class="option-item">
          <span class="option-letter">A</span>
          <div>
            <div>Merge into <strong>AX-PROD-00912</strong> — treat as the same product</div>
            <div class="option-risk-note">⚠ Irreversible — manual data surgery to undo. Pollutes all future comparisons for this product.</div>
          </div>
        </div>
        <div class="option-item">
          <span class="option-letter">B</span>
          <div>
            <div>Create new catalogue entry for <strong>Paracetamol 125mg/5ml</strong></div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Reversible. Adds one product line; may require deduplication later if suppliers are genuinely offering the same thing.</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ── LEAD TIME CONFLICT (D-1064) ────────────────────────────────── */
function renderLeadTimeConflictValues(d) {
  const pv = d.proposed_values;
  const opts = pv.options_generated || [];

  return `
    <table class="values-table" style="margin-bottom:16px;">
      <tbody>
        <tr>
          <td class="field-key">Buyer</td>
          <td class="field-val">${pv.buyer}</td>
          <td class="field-conf-cell"></td>
        </tr>
        <tr>
          <td class="field-key">Required delivery</td>
          <td class="field-val" style="color:var(--high);font-weight:600;">${pv.required_delivery_by}</td>
          <td class="field-conf-cell"></td>
        </tr>
        <tr>
          <td class="field-key">Supplier</td>
          <td class="field-val">${pv.supplier}</td>
          <td class="field-conf-cell"></td>
        </tr>
        <tr>
          <td class="field-key">Quoted lead time</td>
          <td class="field-val">${pv.quoted_lead_time_days} days</td>
          <td class="field-conf-cell"></td>
        </tr>
        <tr>
          <td class="field-key">Projected delivery</td>
          <td class="field-val" style="color:var(--high);font-weight:600;">
            ${pv.projected_delivery} <span style="font-size:12px;font-weight:400;color:var(--high);">(12 days late)</span>
          </td>
          <td class="field-conf-cell"></td>
        </tr>
      </tbody>
    </table>
    <div class="options-block">
      <div class="options-title">Options the agent generated (pick one)</div>
      ${opts.map((opt, i) => `
        <div class="option-item">
          <span class="option-letter">${String.fromCharCode(65+i)}</span>
          <div>${opt}</div>
        </div>
      `).join('')}
    </div>
  `;
}

/* ── EVIDENCE ───────────────────────────────────────────────────── */
function renderEvidenceItem(ev, did, idx, upstreamErrors) {
  const evId = `ev-${did}-${idx}`;
  const isUpstream = upstreamErrors.some(ue => ev.source === ue.id);
  const qualityCls = ev.quality && ev.quality.includes('clean') ? 'eq-clean'
                   : ev.quality && (ev.quality.includes('glare') || ev.quality.includes('scan')) ? 'eq-poor'
                   : 'eq-partial';
  const qualityLabel = ev.quality
    ? `<span class="ev-quality-tag ${qualityCls}">${ev.quality}</span>`
    : '';

  return `
    <div class="evidence-item" id="${evId}">
      <button class="evidence-toggle" onclick="toggleEvidence('${evId}')">
        <span class="ev-icon">▶</span>
        <span class="ev-source">${ev.source}</span>
        <span class="ev-locator">${ev.locator || ''}</span>
        ${isUpstream ? `<span class="ev-flagged">⚠ Flagged as error</span>` : ''}
      </button>
      <div class="evidence-detail" id="${evId}-detail" style="display:none;">
        ${ev.quality ? `<div class="ev-quality">Document quality: ${qualityLabel}</div>` : ''}
        ${ev.locator ? `<div style="font-size:12px;color:var(--text-muted);">Location: <span style="font-family:var(--mono);">${ev.locator}</span></div>` : ''}
        ${ev.quote ? `<div class="ev-quote">&ldquo;${ev.quote}&rdquo;</div>` : ''}
        ${isUpstream ? `<div style="padding:8px 10px;background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:4px;font-size:12px;color:var(--warn);margin-top:6px;"><strong>⚠ This evidence source (${ev.source}) is flagged as incorrect.</strong> Any value derived from it should be treated as unreliable until corrected.</div>` : ''}
      </div>
    </div>
  `;
}

/* ── AGENT QUESTION ─────────────────────────────────────────────── */
function renderAgentQuestion(d) {
  const isExpanded = state.aqExpanded.has(d.id);
  return `
    <div class="agent-question-block" id="aq-block-${d.id}">
      <div class="aq-label">💬 Agent's question for you</div>
      <div class="aq-question">"${d.agent_question}"</div>
      ${isExpanded ? `
        <div class="aq-input-row">
          <textarea class="aq-input" id="aq-input-${d.id}" placeholder="Type your answer…" rows="2"></textarea>
          <button class="btn btn-ask btn-sm" onclick="submitAgentAnswer('${d.id}')">Send answer</button>
        </div>
      ` : `
        <button class="btn btn-ask btn-sm" onclick="expandAQ('${d.id}')">Answer this question</button>
      `}
    </div>
  `;
}

/* ── ACTION BAR ─────────────────────────────────────────────────── */
function renderActionBar(d) {
  const isPending   = d.status === 'pending_review';
  const isExecuted  = d.status === 'executed';
  const isAuto      = d.status === 'auto_approved';
  const isFailed    = d.status === 'failed';
  const hasUpstream = getUpstreamErrors(d).length > 0;
  const actionTaken = state.actionsTaken.has(d.id);
  const disabled    = actionTaken ? 'disabled' : '';

  let buttons = '';

  if (isPending && hasUpstream) {
    buttons += `<button class="btn btn-trace" onclick="navigate('#/error-trace/${d.id}')" title="Hold until upstream error is resolved">⚠ View error trace first</button>`;
  }

  if (isPending || isExecuted || isAuto) {
    buttons += `<button class="btn btn-approve" ${disabled} onclick="takeAction('${d.id}','Approved')" title="Approve and let agent proceed">✓ Approve</button>`;
  }

  if (isPending) {
    buttons += `<button class="btn btn-edit" ${disabled} onclick="enterEditMode('${d.id}')" title="Make inline corrections">✎ Edit values</button>`;
    buttons += `<button class="btn btn-reject" ${disabled} onclick="takeAction('${d.id}','Rejected')" title="Reject — agent will re-evaluate">✕ Reject</button>`;
  }

  if (d.known_error) {
    buttons += `<button class="btn btn-correct" onclick="showCorrectModal()" title="Correct the underlying error">✎ Correct this decision</button>`;
  }

  if (isFailed) {
    buttons += `<button class="btn btn-edit" onclick="showToast('Manual entry mode — paste document text below')" title="Enter values manually">✎ Enter manually</button>`;
  }

  buttons += `<button class="btn btn-escalate" ${disabled} onclick="takeAction('${d.id}','Escalated')" title="Flag for senior review">↑ Escalate</button>`;

  if (d.agent_question) {
    buttons += `<button class="btn btn-ask" ${disabled} onclick="expandAQ('${d.id}')" title="Respond to agent's question">💬 Answer agent</button>`;
  }

  return `
    <div class="action-bar" id="action-bar-${d.id}">
      <span class="action-bar-label">Action:</span>
      ${buttons}
      <div class="action-bar-right">
        <span class="action-audit-note">All actions are logged with timestamp and reviewer ID (CL)</span>
      </div>
    </div>
  `;
}

/* ── ERROR TRACE PAGE ───────────────────────────────────────────── */
function renderErrorTrace(id) {
  // The id passed is the affected decision (D-1058); trace back to origin (D-1042)
  const affected = DECISIONS.find(d => d.id === id);
  const origin   = DECISIONS.find(d => d.id === 'D-1042');

  if (!affected || !origin) return `<p style="padding:32px;color:var(--text-muted);">Trace not found. <a href="#/worklist">Back</a></p>`;

  return `
    <div class="trace-page">

      <div class="detail-nav">
        <a href="#/decision/${id}" class="back-link">← Back to ${id}</a>
        <span class="breadcrumb">Error trace · ${origin.id} → ${affected.id}</span>
      </div>

      <div class="trace-header">
        <h1>Error trace: ${origin.id} → ${affected.id}</h1>
        <p class="trace-intro">
          This view shows how a single incorrect autonomous decision silently corrupted a downstream recommendation.
          Neither decision was reviewed at the time. The error was caught by luck, two days later.
        </p>
      </div>

      <div class="trace-chain">

        <!-- ORIGIN NODE -->
        <div class="trace-node trace-node-origin">
          <div class="trace-node-label">⛔ Origin of error</div>
          <div class="trace-node-id-row">
            <span class="trace-node-id">${origin.id}</span>
            ${agentBadge(origin.agent)}
            <span style="font-size:13px;color:var(--text-muted);">${ACTION_LABELS[origin.action_type]}</span>
            <span class="badge badge-executed">Executed</span>
            <span class="badge badge-risk-high">High risk</span>
          </div>
          <div class="trace-detail-block">
            <strong>What happened:</strong> The normalisation agent processed Cipla Ltd's salbutamol inhaler quotation.
            It assumed each inhaler was an individual sellable unit (pack size = 1), producing a price of <strong style="color:var(--high);font-family:var(--mono);">$3.40/unit</strong>.
            The document states a carton of 10 inhalers as the minimum sellable unit — this was not read.
            The correct price per unit is <strong style="color:var(--low);font-family:var(--mono);">$0.34</strong> — a 10× difference.
          </div>
          <div>
            <div class="trace-fact-row"><span class="trace-fact-key">Confidence at time of execution</span><span class="trace-fact-val">93% — <em>misleadingly high</em></span></div>
            <div class="trace-fact-row"><span class="trace-fact-key">Executed without review?</span><span class="trace-fact-val" style="color:var(--high);">Yes — no human saw this before the agent acted</span></div>
            <div class="trace-fact-row"><span class="trace-fact-key">Assumed pack size (wrong)</span><span class="trace-fact-val trace-fact-val-err">1 inhaler</span></div>
            <div class="trace-fact-row"><span class="trace-fact-key">Correct pack size</span><span class="trace-fact-val trace-fact-val-fix">10 inhalers/carton</span></div>
            <div class="trace-fact-row"><span class="trace-fact-key">Price per unit recorded</span><span class="trace-fact-val trace-fact-val-err">$3.40 (10× inflated)</span></div>
            <div class="trace-fact-row"><span class="trace-fact-key">Correct price per unit</span><span class="trace-fact-val trace-fact-val-fix">$0.34</span></div>
            <div class="trace-fact-row"><span class="trace-fact-key">How it surfaced</span><span class="trace-fact-val">${origin.how_it_surfaced}</span></div>
          </div>
          <div class="trace-node-actions">
            <a href="#/decision/${origin.id}" class="btn btn-sm btn-escalate">Inspect ${origin.id}</a>
            <button class="btn btn-sm btn-correct" onclick="showCorrectModal()">Correct D-1042</button>
          </div>
        </div>

        <div class="trace-arrow">
          <div class="trace-arrow-line"></div>
        </div>
        <div style="padding:4px 22px 8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--high);">
          ↓ Error propagated through evidence dependency
        </div>

        <!-- AFFECTED NODE -->
        <div class="trace-node trace-node-affected">
          <div class="trace-node-label">⚠ Affected decision</div>
          <div class="trace-node-id-row">
            <span class="trace-node-id">${affected.id}</span>
            ${agentBadge(affected.agent)}
            <span style="font-size:13px;color:var(--text-muted);">${ACTION_LABELS[affected.action_type]}</span>
            <span class="badge badge-pending">⏸ Pending review</span>
            <span class="badge badge-risk-high">High risk</span>
            <span class="badge badge-exposure">${fmtMoney(affected.financial_exposure_usd)} exposure</span>
          </div>
          <div class="trace-detail-block">
            <strong>How it was affected:</strong> The award recommendation used D-1042's inflated Cipla price ($3.40/unit)
            when evaluating suppliers for a 1.4M-unit salbutamol award.
            At $3.40, Cipla appeared far more expensive than Sun Pharmaceutical ($0.29) and Zydus ($0.34),
            so it was excluded with the note <em>"price_per_unit 3.40 — far above alternatives."</em>
            <br><br>
            With Cipla's <strong>actual</strong> price of $0.34/unit, it is competitive with Zydus
            and the award split may change materially.
            A reviewer looking only at D-1058 had no reason to question the exclusion.
          </div>
          <div>
            <div class="trace-fact-row"><span class="trace-fact-key">Cipla price used in recommendation</span><span class="trace-fact-val trace-fact-val-err">$3.40/unit (from D-1042)</span></div>
            <div class="trace-fact-row"><span class="trace-fact-key">Cipla's likely actual price</span><span class="trace-fact-val trace-fact-val-fix">~$0.34/unit</span></div>
            <div class="trace-fact-row"><span class="trace-fact-key">Outcome with bad data</span><span class="trace-fact-val">Cipla excluded; split between Sun (65%) and Zydus (35%)</span></div>
            <div class="trace-fact-row"><span class="trace-fact-key">Potential impact if corrected</span><span class="trace-fact-val">Award split may change; Cipla could win a share — potential additional saving</span></div>
            <div class="trace-fact-row"><span class="trace-fact-key">Financial exposure</span><span class="trace-fact-val">${fmtMoney(affected.financial_exposure_usd)}</span></div>
          </div>
          <div class="trace-node-actions">
            <a href="#/decision/${affected.id}" class="btn btn-sm btn-escalate">Back to ${affected.id}</a>
            <button class="btn btn-sm btn-correct" onclick="showReRunModal()">Re-evaluate once D-1042 is corrected</button>
            <button class="btn btn-sm btn-trace" onclick="showBuyerNotifyModal()">Notify buyer to hold</button>
          </div>
        </div>

        <div class="trace-arrow">
          <div class="trace-arrow-line"></div>
        </div>
        <div style="padding:4px 22px 8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:#475569;">
          ↓ Would affect (if D-1058 approved with bad data)
        </div>

        <!-- BUYER NODE -->
        <div class="trace-node trace-node-buyer">
          <div class="trace-node-label">↓ Downstream buyer impact</div>
          <div class="trace-node-id-row">
            <span class="trace-node-id" style="font-family:var(--font);font-size:15px;">Ministry of Health — Country A</span>
            <span class="badge badge-pending">Not yet notified</span>
          </div>
          <div class="trace-detail-block">
            If D-1058 is approved in its current state:
            a compliant, price-competitive supplier (Cipla Ltd) is excluded from a $448K award on incorrect data.
            The award goes to two suppliers on terms that may not be optimal.
            Once the buyer signs, reversing the exclusion may be contractually difficult.
          </div>
          <div class="trace-node-actions">
            <button class="btn btn-sm btn-escalate" onclick="showBuyerNotifyModal()">Draft notification to buyer</button>
            <button class="btn btn-sm btn-escalate" onclick="takeAction('${affected.id}','Escalated')">Escalate to senior review</button>
          </div>
        </div>

      </div>

      <!-- MECHANISM SECTION -->
      <div class="trace-mechanism">
        <div class="mechanism-title">
          🔍 How this should be caught — not by luck
        </div>
        <div class="mechanism-status">
          <strong>Current state:</strong> This error was caught by accident, two days after execution, when a commercial lead
          noticed Cipla missing from a shortlist and started investigating manually.
          No automated detection was in place.
        </div>
        <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:10px;">Proposed mechanism: Dependency Re-check</div>
        <div class="mechanism-steps">
          <div class="mechanism-step"><span class="step-num">1</span><span>When any decision is later flagged as incorrect (by a reviewer, audit, or external signal), the system identifies all decisions that cited it as evidence.</span></div>
          <div class="mechanism-step"><span class="step-num">2</span><span>Those decisions are automatically moved to <strong>"flagged for re-review"</strong> status — even if already executed or previously approved — and surfaced in the reviewer's queue with a warning badge.</span></div>
          <div class="mechanism-step"><span class="step-num">3</span><span>A banner appears: "This decision's inputs have changed — re-evaluation needed." The reviewer sees exactly which upstream decision changed and what the effect is.</span></div>
          <div class="mechanism-step"><span class="step-num">4</span><span>If a flagged decision had already reached a buyer, an immediate alert fires to the commercial lead before any contracts are signed.</span></div>
        </div>
        <div class="mechanism-outcomes">
          <div class="mechanism-outcomes-title">This mechanism would have:</div>
          <div class="mechanism-outcome-item">Placed D-1058 in "flagged for re-review" the same day D-1042 was corrected</div>
          <div class="mechanism-outcome-item">Surfaced the issue in the reviewer queue — not buried in a shortlist</div>
          <div class="mechanism-outcome-item">Prevented the award recommendation reaching the buyer with incorrect data</div>
          <div class="mechanism-outcome-item">Given the reviewer a direct path: correct D-1042 → re-run D-1058 → re-review → send</div>
        </div>
        <div class="section-title" style="margin-bottom:10px;">What to do now</div>
        <div class="checklist">
          <label class="checklist-item"><input type="checkbox"> Correct D-1042: set pack_size = 10, price_per_unit = $0.34</label>
          <label class="checklist-item"><input type="checkbox"> Re-evaluate D-1058 with corrected Cipla price</label>
          <label class="checklist-item"><input type="checkbox"> Review the updated award recommendation before sending to buyer</label>
          <label class="checklist-item"><input type="checkbox"> Notify Cipla Ltd that their offer is back under consideration</label>
        </div>
        <div class="flex-row" style="margin-top:4px;">
          <button class="btn btn-correct" onclick="showCorrectModal()">Correct D-1042</button>
          <button class="btn btn-edit" onclick="showReRunModal()">Re-run D-1058</button>
          <button class="btn btn-trace" onclick="showBuyerNotifyModal()">Notify buyer</button>
          <button class="btn btn-escalate" onclick="takeAction('D-1058','Escalated')">Escalate to senior</button>
        </div>
      </div>

    </div>
  `;
}

/* ── INTERACTIONS ───────────────────────────────────────────────── */
function toggleEvidence(id) {
  const detail = document.getElementById(id + '-detail');
  const btn    = document.querySelector(`#${id} .ev-icon`);
  const item   = document.getElementById(id);
  if (!detail) return;
  const open = detail.style.display !== 'none';
  detail.style.display = open ? 'none' : 'block';
  if (btn)  btn.textContent = open ? '▶' : '▼';
  if (item) item.classList.toggle('ev-open', !open);
}

function expandAQ(decisionId) {
  state.aqExpanded.add(decisionId);
  const d = DECISIONS.find(x => x.id === decisionId);
  const block = document.getElementById(`aq-block-${decisionId}`);
  if (block && d) {
    block.outerHTML = renderAgentQuestion(d);
  }
  // Scroll the detail panel to the input field
  const panel = document.getElementById('detail-panel');
  const target = document.getElementById(`aq-block-${decisionId}`) || document.getElementById(`aq-input-${decisionId}`);
  if (panel && target) {
    const offset = target.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 16;
    panel.scrollTo({ top: offset, behavior: 'smooth' });
  }
  // Focus the textarea after scroll settles
  setTimeout(function() {
    const input = document.getElementById(`aq-input-${decisionId}`);
    if (input) input.focus();
  }, 350);
}

function submitAgentAnswer(decisionId) {
  const input = document.getElementById(`aq-input-${decisionId}`);
  const answer = input ? input.value.trim() : '';
  if (!answer) { showToast('Please type an answer before sending.'); return; }
  state.actionsTaken.set(decisionId, {
    action: `Answered agent's question`,
    timestamp: currentTime(),
    note: `"${answer.slice(0, 60)}${answer.length > 60 ? '…' : ''}"`
  });
  showToast(`Answer logged and sent to agent at ${currentTime()}. Reference: ${decisionId}-AQ`);
  refreshDetailAuditBanner(decisionId);
}

function takeAction(decisionId, action) {
  const descriptions = {
    'Approved':  'Decision approved. Agent may proceed.',
    'Rejected':  'Decision rejected. Agent will re-evaluate.',
    'Escalated': 'Flagged for senior review.',
  };
  const note = descriptions[action] || '';
  state.actionsTaken.set(decisionId, {
    action,
    timestamp: currentTime(),
    note,
  });
  showToast(`✓ ${action} — logged by CL at ${currentTime()}. Ref: ${decisionId}-${action.slice(0,3).toUpperCase()}`);
  refreshDetailAuditBanner(decisionId);
  disableActionBar(decisionId);
}

function enterEditMode(decisionId) {
  const body = document.getElementById(`detail-body-${decisionId}`);
  if (!body) return;
  body.classList.add('editing');

  // Replace the values table section title and add Save/Cancel
  const actionBar = document.getElementById(`action-bar-${decisionId}`);
  if (actionBar) {
    const existing = actionBar.querySelector('.edit-save-row');
    if (!existing) {
      const editRow = document.createElement('div');
      editRow.className = 'edit-save-row';
      editRow.style.cssText = 'display:flex;gap:8px;width:100%;margin-top:8px;padding-top:10px;border-top:1px solid var(--border);';
      editRow.innerHTML = `
        <span style="font-size:12px;color:var(--blue);font-weight:600;align-self:center;">Edit mode — modify fields above, then save.</span>
        <button class="btn btn-approve btn-sm" onclick="saveEdits('${decisionId}')">Save changes</button>
        <button class="btn btn-escalate btn-sm" onclick="cancelEdits('${decisionId}')">Cancel</button>
      `;
      actionBar.appendChild(editRow);
    }
  }
  showToast('Edit mode active — modify field values, then save.');
}

function saveEdits(decisionId) {
  const body = document.getElementById(`detail-body-${decisionId}`);
  if (!body) return;

  const inputs = body.querySelectorAll('.fv-input');
  const changes = [];
  inputs.forEach(inp => {
    const field = inp.dataset.field;
    const newVal = inp.value.trim();
    const displayEl = inp.previousElementSibling;
    const oldVal = displayEl ? displayEl.textContent.trim() : '';
    if (newVal && newVal !== oldVal && oldVal !== 'Agent couldn\'t determine this — manual input required') {
      changes.push(`${fieldLabel(field)}: "${oldVal}" → "${newVal}"`);
      if (displayEl) displayEl.textContent = newVal;
    } else if (newVal && displayEl && displayEl.classList.contains('value-unknown')) {
      changes.push(`${fieldLabel(field)}: [unknown] → "${newVal}"`);
      displayEl.textContent = newVal;
      displayEl.classList.remove('value-unknown');
    }
  });

  body.classList.remove('editing');
  const editRow = document.querySelector('.edit-save-row');
  if (editRow) editRow.remove();

  if (changes.length > 0) {
    state.actionsTaken.set(decisionId, {
      action: 'Edited',
      timestamp: currentTime(),
      note: changes.slice(0, 2).join('; ') + (changes.length > 2 ? ' (+' + (changes.length - 2) + ' more)' : ''),
    });
    showToast(`✓ ${changes.length} field(s) updated and logged at ${currentTime()}. Ref: ${decisionId}-EDIT`);
    refreshDetailAuditBanner(decisionId);
  } else {
    showToast('No changes detected.');
  }
}

function cancelEdits(decisionId) {
  const body = document.getElementById(`detail-body-${decisionId}`);
  if (body) body.classList.remove('editing');
  const editRow = document.querySelector('.edit-save-row');
  if (editRow) editRow.remove();
}

function disableActionBar(decisionId) {
  const bar = document.getElementById(`action-bar-${decisionId}`);
  if (!bar) return;
  bar.querySelectorAll('.btn-approve, .btn-reject, .btn-edit, .btn-escalate, .btn-ask').forEach(b => {
    if (!b.classList.contains('btn-correct') && !b.classList.contains('btn-trace')) {
      b.disabled = true;
    }
  });
}

function refreshDetailAuditBanner(decisionId) {
  const entry = state.actionsTaken.get(decisionId);
  if (!entry) return;
  const bannerHtml = renderAuditBanner(entry);
  if (state.splitView) {
    // In split view there's no .detail-nav — prepend inside the scroll panel
    const panel = document.getElementById('detail-panel');
    if (!panel) return;
    const existing = panel.querySelector('.audit-banner');
    if (existing) { existing.outerHTML = bannerHtml; }
    else { panel.insertAdjacentHTML('afterbegin', bannerHtml); }
  } else {
    const nav = document.querySelector('.detail-nav');
    if (!nav) return;
    const existing = nav.nextElementSibling;
    if (existing && existing.classList.contains('audit-banner')) { existing.outerHTML = bannerHtml; }
    else { nav.insertAdjacentHTML('afterend', bannerHtml); }
  }
}

function showCorrectModal() {
  showModal(
    'Correct D-1042',
    `Set <strong>assumed_pack_size = 10</strong> and <strong>price_per_unit = $0.34</strong> for Cipla Ltd — Salbutamol 100mcg inhaler.<br><br>
     This will flag D-1058 for immediate re-evaluation, as it cited D-1042 as evidence.<br><br>
     <em style="color:var(--text-faint);font-size:12px;">Prototype note: this logs the action and shows the intended effect, but doesn\'t re-run the actual downstream calculation.</em>`,
    [
      { label: 'Apply correction', cls: 'btn-correct', fn: () => { hideModal(); takeAction('D-1042', 'Corrected'); showToast('D-1042 corrected. D-1058 has been flagged for re-evaluation.'); } },
      { label: 'Cancel', cls: 'btn-escalate', fn: hideModal },
    ]
  );
}

function showReRunModal() {
  showModal(
    'Re-evaluate D-1058',
    `Re-run the award recommendation for salbutamol with the corrected Cipla price ($0.34/unit).<br><br>
     The agent will recalculate the optimal split across all suppliers including Cipla, and return a new recommendation for your review.<br><br>
     <em style="color:var(--text-faint);font-size:12px;">Prototype note: this logs the action and shows the intended effect, but doesn\'t re-run the actual downstream calculation.</em>`,
    [
      { label: 'Re-run D-1058', cls: 'btn-edit', fn: () => { hideModal(); showToast('D-1058 queued for re-evaluation with corrected inputs. New result will appear in your queue.'); } },
      { label: 'Cancel', cls: 'btn-escalate', fn: hideModal },
    ]
  );
}

function showBuyerNotifyModal() {
  showModal(
    'Notify buyer to hold',
    `Draft an email to Ministry of Health — Country A (MOH-A-2026-114) asking them to delay signing until the recommendation is re-evaluated.<br><br>
     No commitment has been made yet — this is a precautionary hold.<br><br>
     <em style="color:var(--text-faint);font-size:12px;">Prototype note: this logs the action and shows the intended effect, but doesn\'t re-run the actual downstream calculation.</em>`,
    [
      { label: 'Draft notification', cls: 'btn-trace', fn: () => { hideModal(); showToast('Notification drafted. Review in comms-agent queue before sending.'); } },
      { label: 'Cancel', cls: 'btn-escalate', fn: hideModal },
    ]
  );
}

function showModal(title, body, actions) {
  const overlay = document.getElementById('modal-overlay');
  const box     = document.getElementById('modal-box');
  const btns = actions.map(a =>
    `<button class="btn ${a.cls}" id="modal-btn-${a.label.replace(/\s/g,'-')}">${a.label}</button>`
  ).join('');
  box.innerHTML = `
    <div class="modal-title">${title}</div>
    <div class="modal-body">${body}</div>
    <div class="modal-actions">${btns}</div>
  `;
  overlay.classList.remove('hidden');
  actions.forEach(a => {
    const btn = document.getElementById(`modal-btn-${a.label.replace(/\s/g,'-')}`);
    if (btn) btn.addEventListener('click', a.fn);
  });
}

function hideModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function showToast(msg) {
  const area = document.getElementById('toast-area');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  area.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; }, 3000);
  setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3400);
}

function currentTime() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/* ── ROUTER ─────────────────────────────────────────────────────── */
function navigate(hash) {
  window.location.hash = hash;
}

/* ── SPLIT VIEW ───────────────────────────────────────────── */
function renderSplitView(selectedId) {
  state.splitView = true;
  state.currentSelectedId = selectedId;

  const pending = DECISIONS
    .filter(d => d.status === 'pending_review')
    .sort((a, b) => {
      const ps = priorityScore(b) - priorityScore(a);
      return ps !== 0 ? ps : (b.financial_exposure_usd || 0) - (a.financial_exposure_usd || 0);
    });
  const failed = DECISIONS.filter(d => d.status === 'failed');
  const acted  = DECISIONS
    .filter(d => d.status === 'executed' || d.status === 'auto_approved')
    .sort((a, b) => priorityScore(b) - priorityScore(a));
  const reviewItems = [...pending, ...failed];
  const totalExposure = pending.reduce((s, d) => s + (d.financial_exposure_usd || 0), 0);

  // Auto-set filter to match the selected decision's set
  if (selectedId) {
    const sel = DECISIONS.find(x => x.id === selectedId);
    if (sel) {
      const isActed = sel.status === 'executed' || sel.status === 'auto_approved';
      state.queueFilter = isActed ? 'acted' : 'needs_review';
    }
  }

  const visibleItems = state.queueFilter === 'needs_review' ? reviewItems : acted;
  const selDecision = selectedId ? DECISIONS.find(x => x.id === selectedId) : null;
  const actionBarHtml = selDecision ? renderActionBar(selDecision) : '';
  const detailContent = selectedId
    ? renderDecisionDetail(selectedId)
    : renderDetailPlaceholder(reviewItems.length, totalExposure);

  return '<div class="split-layout">' +
    // Row 1: header cells
    '<div class="queue-header">' +
      '<div class="qph-title"><span>Decision queue</span></div>' +
      '<div class="qph-meta">' + fmtMoney(totalExposure) + ' pending exposure &middot; sorted by risk</div>' +
    '</div>' +
    '<div class="action-bar-slot" id="action-bar-slot">' + actionBarHtml + '</div>' +
    // Row 2 col 1: filter tabs + scrollable items
    '<div class="queue-left-body">' +
      renderQueueFilterTabs(reviewItems.length, acted) +
      '<div class="queue-panel-scroll" id="queue-panel-scroll">' +
        renderAutonomyKey() +
        visibleItems.map(d => renderQueueItem(d, d.id === selectedId)).join('') +
      '</div>' +
    '</div>' +
    // Row 2 col 2: detail content
    '<div class="detail-panel" id="detail-panel">' + detailContent + '</div>' +
  '</div>';
}

function renderQueueFilterTabs(reviewCount, acted) {
  const isReview = state.queueFilter === 'needs_review';
  const errorCount = acted.filter(d => d.known_error === true).length;
  const errorBadge = errorCount > 0
    ? ' <span class="badge badge-known-error" style="font-size:10px;padding:1px 5px;">&#9888; ' + errorCount + '</span>'
    : '';
  return '<div class="queue-filter-tabs">' +
    '<button class="qft-tab ' + (isReview  ? 'qft-tab-active' : '') + '" data-filter="needs_review" onclick="setQueueFilter(\'needs_review\')">' +
      'Needs review <span class="qft-count">' + reviewCount + '</span>' +
    '</button>' +
    '<button class="qft-tab ' + (!isReview ? 'qft-tab-active' : '') + '" data-filter="acted" onclick="setQueueFilter(\'acted\')">' +
      'Agent acted <span class="qft-count">' + acted.length + '</span>' + errorBadge +
    '</button>' +
  '</div>';
}

function setQueueFilter(filter) {
  state.queueFilter = filter;
  const pending = DECISIONS
    .filter(d => d.status === 'pending_review')
    .sort((a, b) => {
      const ps = priorityScore(b) - priorityScore(a);
      return ps !== 0 ? ps : (b.financial_exposure_usd || 0) - (a.financial_exposure_usd || 0);
    });
  const failed = DECISIONS.filter(d => d.status === 'failed');
  const acted  = DECISIONS
    .filter(d => d.status === 'executed' || d.status === 'auto_approved')
    .sort((a, b) => priorityScore(b) - priorityScore(a));
  const items = filter === 'needs_review' ? [...pending, ...failed] : acted;
  const sid = state.currentSelectedId;

  const scroll = document.getElementById('queue-panel-scroll');
  if (scroll) {
    scroll.innerHTML = renderAutonomyKey() + items.map(d => renderQueueItem(d, d.id === sid)).join('');
    scroll.scrollTop = 0;
  }
  document.querySelectorAll('.qft-tab').forEach(function(tab) {
    tab.classList.toggle('qft-tab-active', tab.dataset.filter === filter);
  });
}

function renderDetailPlaceholder(count, exposure) {
  return '<div class="detail-placeholder">' +
    '<div class="detail-placeholder-icon" style="font-size:28px;opacity:0.25;">&#8592;</div>' +
    '<div class="detail-placeholder-title">Select a decision to review</div>' +
    '<div class="detail-placeholder-sub">' + count + ' decision' + (count !== 1 ? 's' : '') +
      ' waiting &middot; ' + fmtMoney(exposure) + ' total exposure</div>' +
  '</div>';
}

function renderQueueItem(d, isSelected) {
  const upstreamErrors = getUpstreamErrors(d);
  const isKnownError   = d.known_error === true;
  const isFailed       = d.status === 'failed';

  let riskCls = 'qi-risk-' + d.risk;
  if (isFailed)     riskCls = 'qi-failed';
  if (isKnownError) riskCls = 'qi-error';

  const topBadges = [];
  if (isKnownError)          topBadges.push('<span class="badge badge-known-error" style="font-size:10px;padding:1px 5px;">! Error</span>');
  if (upstreamErrors.length) topBadges.push('<span class="badge badge-upstream" style="font-size:10px;padding:1px 5px;">! Upstream</span>');
  topBadges.push(statusBadge(d.status));
  topBadges.push(riskBadge(d.risk));
  if (d.reversible === false) topBadges.push('<span class="badge badge-irreversible" style="font-size:10px;padding:1px 5px;">Irrev.</span>');

  const exposure = d.financial_exposure_usd > 0
    ? '<span class="qi-exposure">' + fmtMoney(d.financial_exposure_usd) + '</span>' : '';

  return '<div class="queue-item ' + riskCls + (isSelected ? ' queue-item-selected' : '') + '"' +
    ' data-id="' + d.id + '"' +
    ' onclick="selectQueueItem(\'' + d.id + '\')"' +
    ' role="button" tabindex="0"' +
    ' onkeydown="if(event.key===\'Enter\') selectQueueItem(\'' + d.id + '\')">' +
    '<div class="qi-top"><span class="qi-id">' + d.id + '</span>' + agentBadge(d.agent) + '</div>' +
    '<p class="qi-summary">' + d.summary + '</p>' +
    '<div class="qi-footer">' + topBadges.join('') + exposure + '</div>' +
  '</div>';
}

function selectQueueItem(id) {
  state.currentSelectedId = id;
  history.replaceState(null, '', '#/decision/' + id);

  const d = DECISIONS.find(x => x.id === id);
  if (!d) return;

  // Auto-switch filter if the selected item isn't in the currently visible set
  const isActed = d.status === 'executed' || d.status === 'auto_approved';
  const targetFilter = isActed ? 'acted' : 'needs_review';
  if (state.queueFilter !== targetFilter) {
    setQueueFilter(targetFilter); // re-renders scroll with correct highlights
  } else {
    document.querySelectorAll('.queue-item').forEach(function(el) {
      el.classList.toggle('queue-item-selected', el.dataset.id === id);
    });
  }

  // Update action bar slot
  const actionSlot = document.getElementById('action-bar-slot');
  if (actionSlot) actionSlot.innerHTML = renderActionBar(d);

  // Render detail panel
  const panel = document.getElementById('detail-panel');
  if (panel) {
    panel.innerHTML = renderDecisionDetail(id);
    panel.scrollTop = 0;
  }
}

/* ── ROUTER ─────────────────────────────────────────────── */
function route() {
  const hash = window.location.hash || '#/worklist';
  const root = document.getElementById('app-root');
  state.editingDecision = null;
  state.splitView = false;

  if (hash.startsWith('#/error-trace/')) {
    const id = hash.slice('#/error-trace/'.length);
    root.innerHTML = renderErrorTrace(id);
    window.scrollTo(0, 0);
  } else {
    // All decision and worklist views use the split layout
    const id = hash.startsWith('#/decision/') ? hash.slice('#/decision/'.length) : null;
    root.innerHTML = renderSplitView(id);
    // Scroll the detail panel to top on navigation
    const panel = document.getElementById('detail-panel');
    if (panel) panel.scrollTop = 0;
  }

  hideModal();
}

/* ── INIT ───────────────────────────────────────────────────────── */
window.addEventListener('hashchange', route);
window.addEventListener('load', route);

// Close modal on overlay click
document.addEventListener('click', function(e) {
  if (e.target && e.target.id === 'modal-overlay') hideModal();
});
