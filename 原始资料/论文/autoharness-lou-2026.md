---
title: "AutoHarness: Improving LLM Agents by Automatically Synthesizing a Code Harness"
author: Xinghua Lou, Miguel Lázaro-Gredilla, Antoine Dedieu, Carter Wendelken, Wolfgang Lehrach, Kevin P. Murphy
date: 2026-02-10
source_type: paper
url: https://arxiv.org/abs/2603.03329
---

# AutoHarness: Improving LLM Agents by Automatically Synthesizing a Code Harness

## Abstract

The research addresses a fundamental problem with language model agents: they frequently attempt actions prohibited by their environment. The authors note that "78% of Gemini-2.5-Flash losses were attributed to illegal moves" in a recent chess competition.

Their solution involves having Gemini-2.5-Flash automatically generate protective code structures through iterative refinement based on environmental feedback. Key findings include:

- The synthesized harness prevented all illegal moves across 145 TextArena games
- The smaller Flash model outperformed larger models like Gemini-2.5-Pro
- When generating complete policies as code, the model achieved higher average rewards than both Gemini-2.5-Pro and GPT-5.2-High on 16 single-player games
- This approach reduces costs while improving performance

Keywords: agent harness, code synthesis, self-improvement, code-as-policy, text games

## Core Contribution

The paper introduces AutoHarness, a method enabling LLMs to automatically synthesize code harnesses that prevent invalid actions in game environments. Rather than relying on manual harness design or fine-tuning, the approach leverages the LLM's own code-generation capabilities through iterative refinement guided by tree search and Thompson sampling.

## Methodology

Core Framework: The system maintains multiple code hypotheses in a tree structure, using Thompson sampling to select which candidate to refine next. The heuristic value measures legal move accuracy.

Three Harness Variants:
1. Action-filter: Generates sets of legal moves; LLM ranks them
2. Action-verifier: LLM proposes action; verification rejects invalid attempts with feedback
3. Policy: Pure code execution at test time without LLM calls

Refinement Process: The LLM acts as a mutation operator, receiving environment feedback about invalid moves and generating improved code. At most 5 failed steps inform each refinement iteration.

Function signatures require `propose_action(board: str) → str` and `is_legal_action(board: str, action: str) → bool`.

Training uses 10 parallel environments with rollouts up to 1000 steps. When illegal moves occur, rollout terminates. The system samples at most 5 failed steps and feeds them to the Critic component, which consolidates various types of errors. These steps with error messages plus original code feed to the Refiner for new code generation.

Refinement instructions include: "If is_legal_action() returns True but the action is invalid, we refine both functions; while if is_legal_action() returns False and the action is invalid, we only refine propose_action()."

Training ends when legal action success rate reaches 1.0 or timeout occurs.

## Experimental Scope

- Tested on: 145 TextArena games (1-player and 2-player, excluding free-form dialog)
- Key modification: Removed "Available Moves" hints to increase difficulty
- Training: Average 14.5 tree search iterations; 19/32 games converged in <10 iterations

## Main Results

2-Player Games (16 games tested):
- Gemini-2.5-Flash+Harness achieved 56.3% win rate vs. Gemini-2.5-Pro (38.2%)
- Won 9/16 games directly; 12/16 when competing against vanilla Flash

1-Player Games (16 games tested):
- Achieved 0.745 average reward vs. Gemini-2.5-Pro's 0.707
- Superior performance in 8/16 games; tied in 5/16

Harness-as-Policy Results (1-player, 16 games):
- Achieved 0.870 average reward, outperforming GPT-5.2 (0.635) and GPT-5.2-High (0.844)
- Generated executable Python code with near-zero test-time cost vs. $640 for GPT models

100% legal action success rate across all 145 games tested.

## Limitations

- Separate harnesses generated for each environment; not generalizable across games
- Two-player policy challenge: "much harder...Two-player games require strategic reasoning about the opponent's policy which often requires MCTS-like methods at run time."
- No ablation studies isolating contributions of tree search, Thompson sampling, or critic/refiner
- No failure mode analysis

## Future Directions

Authors propose: (1) distilling learned domain-specific experts back into base LLMs for recursive self-improvement, (2) building reusable harness libraries, and (3) extending to multimodal games like Craftax and Terra Nova.
