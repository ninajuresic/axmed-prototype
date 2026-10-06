# Agent Review Tool

A review queue where a Commercial Lead checks, corrects and approves what AI agents decided in a pharmaceutical procurement workflow.

**Live prototype:** [ninajuresic.github.io/axmed-prototype](https://ninajuresic.github.io/axmed-prototype/)

## The problem

Seven agents work on supplier quotes: extraction, critic, catalogue, normalisation, compliance, sourcing and comms. Their decisions flow downstream, so one wrong call early on spreads into everything built on it. The agents also rate their own confidence, and that rating can be wrong.

The scenario covers one working day, 12 decisions, and three cases that test the design:

- **A confident mistake:** a unit-price normalisation assumed the wrong pack size and inflated the cost 10×, with high confidence and no review.
- **A price outlier:** Metformin quoted 68% below benchmark, held for checking before it feeds into aggregation.
- **Two agents disagreeing:** extraction and critic read a Spanish supplier's currency differently, $ vs EUR.

## How it works

**A worklist sorted by what's at stake.** The queue ranks decisions by risk, reversibility, financial exposure, known errors and upstream problems, so confidence alone never decides what gets reviewed. Two tabs split "Needs review" from "Agent acted", and a banner shows the total financial exposure still pending.

**Evidence next to every value.** Each decision shows the proposed values with a confidence score per field, the agent's reasoning, its downstream effect, and the source documents behind it, with the exact location, the quote and a quality tag (clean, glare, scan).

**Layouts for each type of problem.** An agent conflict shows "Extraction agent says" and "Critic agent says" side by side. A normalisation error shows the wrong and correct pack size. Award splits show each supplier's share.

**Five reviewer actions:** approve, reject, edit values, escalate to a senior, or answer the agent's question. Every action is logged with a timestamp, the reviewer and a reference ID, so there's an audit trail.

**Error recovery.** When a decision turns out to be wrong, an error trace shows how it spread: from the origin, to the decisions built on it, to the buyer. From there the reviewer corrects the source, re-runs the affected decisions with the fixed input, and asks the buyer to hold before a contract is signed.

## How I built it

I designed the review flow and built it in code with Zed and Claude, using plain HTML, CSS and JavaScript. The scenario data lives in `agent-decisions.json`.
