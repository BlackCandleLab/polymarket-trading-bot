<div align="center">

# Polymarket BTC Up/Down Trading Bot

### BTC 5m Up/Down · CLOB arbitrage · copy-trading · Polygon

A production-oriented **Node.js** trading bot for **Polymarket** short-duration **Up/Down** markets on **Polygon**, with both **arbitrage** and **copy-trading** workflows.

<p>
  <a href="https://github.com/POLYMARKET-SPORTS/Polymarket-trading-bot"><b>GitHub · POLYMARKET-SPORTS/Polymarket-trading-bot</b></a>
  &nbsp;·&nbsp;
  <a href="https://polymarket.com"><b>Polymarket.com</b></a>
</p>

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Polymarket](https://img.shields.io/badge/Polymarket-polymarket.com-5D3FD3)](https://polymarket.com)
[![GitHub](https://img.shields.io/badge/GitHub-POLYMARKET--SPORTS%2FPolymarket--trading--bot-181717?logo=github)](https://github.com/POLYMARKET-SPORTS/Polymarket-trading-bot)

</div>

<sub>

**Keywords:** polymarket copy trading bot polymarket arbitrage bot, polymarket copy trading bot polymarket arbitrage bot, polymarket copy trading bot polymarket arbitrage bot, polymarket copy trading bot polymarket arbitrage bot, polymarket copy trading bot polymarket arbitrage bot, polymarket copy trading bot polymarket  bot,

</sub>

---

### Contents

- [Why this repository](#why-this-repository)
- [Overview](#overview)
- [Screenshots](#screenshots)
- [Detailed Runbook](#detailed-runbook)
- [Key Features](#key-features)
- [Repository Modes](#repository-modes)
- [Strategy Summary](#strategy-summary)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Quick Start](#quick-start)
- [Logging and Output](#logging-and-output)
- [Project Structure](#project-structure)
- [File Guide](#file-guide)
- [Practical Safety Notes](#practical-safety-notes)
- [Troubleshooting](#troubleshooting)
- [Recommended First Run](#recommended-first-run)
- [Disclaimer](#disclaimer)

---

## Why this repository

This project is built for users who need an operational trading runtime instead of a toy script:

- Real CLOB authentication and order execution on Polymarket
- On-chain approvals, merge, and redeem transaction flows
- Real-time order-book monitoring via WebSocket with fallback logic
- Configurable risk limits, circuit breakers, and graceful shutdown behavior
- Dedicated copy-trading path for mirroring selected wallet activity

This repository contains:

- A **5-minute BTC Up/Down arbitrage bot** that posts both sides of the market, takes mispriced liquidity, merges matched pairs, and redeems after resolution.
- An **integrated wallet-following module** that can mirror future buys from a target wallet during the main runtime.
- A **dedicated buy-only copy trader** under `src/copy/` that polls Polymarket's public trade feed and reacts to fresh target-wallet buys.

The codebase is structured for real trading: on-chain approvals, Polymarket CLOB authentication, WebSocket order-book tracking, risk caps, circuit breakers, structured logging, and graceful shutdown handling are all included.

> Important: This software places live blockchain and market orders. Use it only if you fully understand the strategy, the wallet setup, the gas implications, and the market risks.

## Overview

This bot is designed around **Polymarket complementary-token markets**, especially the recurring `btc-updown-5m-*` markets.

At a high level, the main arbitrage engine:

1. Loads your signer and Polymarket proxy wallet configuration.
2. Ensures the required Polygon approvals are in place.
3. Derives or refreshes Polymarket CLOB API credentials automatically.
4. Discovers the next 5-minute BTC Up/Down market before it opens.
5. Posts a symmetric buy ladder on both `Up` and `Down`.
6. Aggressively buys both sides when the combined ask becomes favorable.
7. Merges matched pairs back into USDC when economically sensible.
8. Cancels open orders at market close.
9. Waits for resolution and redeems winning positions.

The repository also supports copy-trading workflows for users who want to follow a target Polymarket wallet with configurable sizing and risk caps.

## Screenshots

The following screenshots show the workflow this bot targets.

### Performance

![1D performance view](img/Screenshot_3.png)

![Past week performance view](img/Screenshot_1.png)

![All-time performance view](img/Screenshot_2.png)

### Activity Snapshot

![Trading activity snapshot](img/G7o1D49WcAErNMi.png)

## Detailed Runbook

1. Install dependencies:

```bash
npm install
```

2. Create your local environment file:

```powershell
Copy-Item .env.example .env
```

or:

```bash
cp .env.example .env
```

3. Configure at minimum:
- `PRIVATE_KEY`
- `PROXY_WALLET`
- `POLYGON_RPC` (strongly recommended)

4. Start with conservative limits and run:

```bash
npm start
```

## Key Features

- **Dual-sided ladder execution** for recurring BTC 5-minute markets.
- **Taker arbitrage logic** when combined best ask drops below the configured edge threshold.
- **On-chain merge and redeem support** for Polymarket negative-risk markets.
- **Session and per-market risk controls** including spend caps and circuit breakers.
- **Automatic CLOB credential derivation** through Polymarket's documented L1-to-L2 auth flow.
- **Live WebSocket order-book tracking** for low-latency price updates.
- **Optional wallet mirroring** for follow-trading workflows.
- **Dedicated copy-trading engine** with filters for stale trades, price bounds, slippage, and cumulative spend.
- **Structured console and file logging** through `winston`.
- **Graceful shutdown** on `SIGINT` / `SIGTERM`.

## Repository Modes

There are two primary ways to use this repository.

### 1. Main Arbitrage Engine

The main runtime lives in `src/index.js`.

It is focused on:

- Discovering the next `btc-updown-5m` market
- Posting both-sided ladders at the open
- Executing taker arb when the market offers enough edge
- Merging matched pairs back into USDC
- Redeeming after oracle resolution

This is the core strategy described by the main `package.json` metadata.

### 2. Copy-Trading Workflows

The repo currently contains **two copy-related paths**:

- **Integrated copy watcher** in `src/copy-trader.js`  
  If `TARGET_WALLET` is set, the main runtime snapshots that wallet's current positions and then mirrors future increases in `totalBought`.

- **Dedicated buy-only copy trader** in `src/copy/`  
  This path uses `src/copy/activityFeed.js` plus `src/copy/copyTrader.js` to detect fresh public trade activity from one or more target wallets and submit capped buy orders quickly.

If your goal is to use the dedicated copy system, read the copy-trading section below carefully and prefer the explicit `src/copy/index.js` entrypoint.

## Strategy Summary

### Main Arb Logic

The core `Trader` class in `src/trader.js` implements a market lifecycle roughly like this:

1. **Wait for market open**  
   The bot discovers the next market before open, then waits until the trading window is live.

2. **Post the ladder**  
   It places buy orders across many configured price levels on both outcomes.

3. **Monitor live best asks**  
   A WebSocket feed keeps the current top-of-book available with REST fallback when needed.

4. **Fire taker arb orders**  
   When `bestAskUp + bestAskDown < 1 - TARGET_EDGE`, the bot submits paired buy orders.

5. **Merge matched pairs**  
   If both outcomes have been accumulated in sufficient size, the bot merges them back into USDC.

6. **Stop buying near market close**  
   It stops adding risk before the window ends, then cancels remaining open orders.

7. **Wait for resolution and redeem**  
   After the market resolves, the bot redeems any winning positions.

### Built-In Risk Controls

The main strategy includes multiple safety mechanisms:

- `MAX_SPEND_PER_MARKET`
- `MAX_TAKER_FILL_USDC`
- `MAX_INVENTORY_IMBALANCE_USDC`
- `COMBINED_ASK_STOP`
- `MAX_LOSS_PER_HOUR_USDC`
- `STOP_BUYING_BEFORE_CLOSE`
- `MERGE_THRESHOLD_USDC`

These controls are not optional decoration. They define how aggressively the bot is allowed to trade and when it must stop.

## Requirements

Before running the bot, make sure you have:

- **Node.js 18+**
- A **Polymarket account**
- Your **Polygon EOA private key**
- Your **Polymarket proxy wallet address**
- **USDC on Polygon**
- Enough native MATIC for gas
- Access to a reliable Polygon RPC endpoint

Recommended:

- Use a dedicated wallet for bot operation
- Start with small size caps
- Use a private RPC provider instead of the default public endpoint
- Test copy workflows with `COPY_DRY_RUN=true` first

## Installation

```bash
npm install
```

The repo already includes a `package-lock.json`, so a normal `npm install` is the intended setup path.

## Configuration

Copy the example environment file.

PowerShell:

```powershell
Copy-Item .env.example .env
```

Bash:

```bash
cp .env.example .env
```

Then edit `.env` with your real wallet and risk settings.

### Minimum Required Settings

These values are essential for almost every real run:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PRIVATE_KEY` | Yes | Your Polygon signer used for approvals and order signing |
| `PROXY_WALLET` | Yes | The Polymarket proxy wallet tied to your account |
| `POLYGON_RPC` | Strongly recommended | Polygon RPC endpoint used by `ethers` |
| `LOG_LEVEL` | No | Console/file logging verbosity |

### Main Arbitrage Settings

These parameters shape the main strategy:

| Variable | What it controls |
| --- | --- |
| `MAX_SPEND_PER_MARKET` | Total buy-side budget for one 5-minute market |
| `TARGET_EDGE` | Minimum combined-price edge before firing arb buys |
| `MERGE_THRESHOLD_USDC` | Minimum matched pair size before merge |
| `MAX_TAKER_FILL_USDC` | Maximum size for a single taker action |
| `MAX_INVENTORY_IMBALANCE_USDC` | Inventory imbalance guardrail |
| `COMBINED_ASK_STOP` | Hard stop if the market becomes too expensive |
| `MAX_LOSS_PER_HOUR_USDC` | Rolling session loss circuit breaker |
| `LADDER_LEVELS` | Ladder prices posted on both sides |
| `LADDER_SIZE_PER_LEVEL_USDC` | Size allocated to each ladder level |

### Copy-Trading Settings

The repo exposes two different copy-trading parameter groups.

#### Integrated Copy Watcher

| Variable | Purpose |
| --- | --- |
| `TARGET_WALLET` | Single target Polymarket wallet to mirror during main runtime |
| `COPY_TRADE_BUY_PERCENT` | Percent of target spend to mirror |
| `COPY_TRADE_POLL_MS` | Poll interval for the target positions API |

#### Dedicated Buy-Only Copy Trader

| Variable | Purpose |
| --- | --- |
| `COPY_TARGETS` | Comma-separated list of target wallets |
| `COPY_SIZE_MODE` | `FIXED`, `MIRROR`, or `RATIO` |
| `COPY_FIXED_USDC` | Fixed spend per copied trade |
| `COPY_RATIO` | Spend multiplier when `COPY_SIZE_MODE=RATIO` |
| `COPY_MAX_USDC_PER_TRADE` | Hard cap per copied trade |
| `COPY_MAX_USDC_PER_MARKET` | Hard cap per market |
| `COPY_MAX_USDC_PER_HOUR` | Rolling hourly cap |
| `COPY_MAX_USDC_TOTAL` | Session-wide cap |
| `COPY_MAX_SLIPPAGE` | Maximum price premium above target fill |
| `COPY_MAX_PRICE` | Upper price filter |
| `COPY_MIN_PRICE` | Lower price filter |
| `COPY_STALE_MS` | Reject stale signals |
| `COPY_POLL_MS` | Poll frequency for target trades |
| `COPY_ALLOWED_CONDITIONS` | Optional allow-list |
| `COPY_BLOCKED_CONDITIONS` | Optional block-list |
| `COPY_DRY_RUN` | Log-only mode without real orders |

### CLOB Credentials

The example file includes:

- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_API_PASSPHRASE`

These can be left blank on first run. The client in `src/clob.js` attempts to derive valid credentials automatically from your signer. If cached credentials become invalid, the client also attempts a refresh flow.

## Quick Start

### Main Arbitrage Bot

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Fill in `PRIVATE_KEY`, `PROXY_WALLET`, and a reliable `POLYGON_RPC`.
4. Start with conservative values such as a smaller `MAX_SPEND_PER_MARKET`.
5. Run the bot.

```bash
npm start
```

You can also run the explicit arb script:

```bash
npm run arb
```

For development mode with Node's file watcher:

```bash
npm run dev
```

or

```bash
npm run arb:dev
```

### Integrated Wallet Mirroring

If you want the main runtime to also mirror future buys from a specific target wallet:

1. Set `TARGET_WALLET` in `.env`.
2. Optionally tune `COPY_TRADE_BUY_PERCENT` and `COPY_TRADE_POLL_MS`.
3. Launch the main bot as normal.

The bot will snapshot existing positions first, then only react to **new buy increases** observed after startup.

### Dedicated Buy-Only Copy Trader

If you want the dedicated `src/copy/` implementation:

1. Configure `COPY_TARGETS`.
2. Set conservative caps.
3. Prefer starting with `COPY_DRY_RUN=true`.
4. Run the dedicated entrypoint directly.

```bash
node src/copy/index.js
```

This path is useful when your focus is low-latency buy-following rather than the BTC 5-minute arbitrage lifecycle.

## Logging and Output

The logger writes:

- Colored structured logs to the console
- JSON logs to `bot.log`

This is useful for:

- Live monitoring
- Post-session debugging
- Reviewing order failures
- Investigating market timing and slippage

## Project Structure

```text
.
|-- .env.example
|-- package.json
|-- img/
|-- src/
|   |-- index.js
|   |-- trader.js
|   |-- copy-trader.js
|   |-- market.js
|   |-- clob.js
|   |-- onchain.js
|   |-- pnl.js
|   |-- logger.js
|   `-- copy/
|       |-- index.js
|       |-- activityFeed.js
|       |-- copyTrader.js
|       `-- config.js
`-- README.md
```

## File Guide

- `src/index.js`  
  Main bot lifecycle, startup, market loop, graceful shutdown, and optional integrated copy watcher.

- `src/trader.js`  
  Per-market state machine for ladder posting, taker arb, merge logic, order cancellation, and redeem flow.

- `src/market.js`  
  Polymarket Gamma/Data API helpers for market discovery, wallet positions, and resolution polling.

- `src/clob.js`  
  CLOB REST and WebSocket client, auth handling, order signing, and order posting utilities.

- `src/onchain.js`  
  Polygon approvals, token balances, merge transactions, and redeem transactions.

- `src/copy-trader.js`  
  Integrated target-wallet mirroring based on changes in target positions.

- `src/copy/activityFeed.js`  
  High-frequency polling of public trade data for specific wallets.

- `src/copy/copyTrader.js`  
  Dedicated copy-trading execution engine with filters and spend accounting.

## Practical Safety Notes

- Do **not** start with large sizing.
- Do **not** run with a wallet you use for unrelated funds.
- Do **not** assume public RPC endpoints are stable enough for serious production usage.
- Do **not** skip reading the `.env.example` comments; they explain the intended meaning of most controls.
- Do start with `COPY_DRY_RUN=true` for copy trading.
- Do verify your proxy wallet address carefully.
- Do keep enough MATIC available for approvals, merges, and redeems.

## Troubleshooting

### The bot exits immediately with a missing env var error

Check `.env` and confirm the required fields are actually populated:

- `PRIVATE_KEY`
- `PROXY_WALLET`

For dedicated copy trading, also confirm:

- `COPY_TARGETS`

### Orders fail or the bot cannot authenticate

- Confirm your signer matches the intended Polymarket account.
- Confirm `PROXY_WALLET` is the correct proxy wallet for that signer.
- Try a stable private Polygon RPC endpoint.
- Leave `POLY_API_*` blank if you want the bot to derive fresh credentials automatically.

### Copy trades are not firing

- Make sure your target wallet address is lowercased correctly in the copy settings.
- Check that the target is placing fresh **BUY** trades, not only sells or old fills.
- Verify your caps are not too restrictive.
- For dedicated copy mode, make sure `COPY_DRY_RUN` is set the way you expect.

### Merge or redeem transactions fail

- Confirm approvals were granted successfully.
- Confirm you hold enough matched positions to merge.
- Confirm the market is actually resolved before expecting redeem payout.
- Check `bot.log` for the underlying error payload.

## Recommended First Run

If you are launching this repo for the first time, the safest path is:

1. Fill `.env` with real wallet values.
2. Use a private RPC endpoint.
3. Lower your spend caps materially.
4. Run the main bot in observation mode with small sizing.
5. If testing copy logic, enable `COPY_DRY_RUN=true` first.
6. Review `bot.log` after a short session before scaling up.

## Disclaimer

This repository is provided for research and operational use by experienced users. It is **not financial advice**, and it does not guarantee profit. Real-money trading on Polymarket and Polygon involves market risk, execution risk, smart contract risk, RPC reliability risk, and operational risk. You are fully responsible for how you configure and use this software.
