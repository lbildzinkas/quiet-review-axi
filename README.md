# quiet-review-axi

Agent-first CLI that scores AI code-review comments with Jev typed decisions to separate real issues from noise.

AI review bots leave many comments on every pull request, and only some of them point at real problems.
Quiet Review asks TypeSafe's Jev model a few typed questions about each comment (is it worth acting on, what kind of issue, how severe, is it a duplicate) and turns the answers into a verdict: **keep**, **unsure** or **collapse**.
Output is compact [AXI](https://github.com/kunchenguid/axi) TOON for coding agents, with `--json` for scripts and a readable mode for people.

## Status

**Specification only. Implementation is pending.**

v0 starts with an accuracy replay on public pull requests: it checks whether Jev's scores separate comments developers acted on from comments they ignored.
The project continues only if the replay passes a rule fixed in advance (AUROC ≥ 0.75, and collapsing at least 40% of noise while hiding at most 5% of real issues).

Planned v0 commands:

- `quiet-review-axi score <pr-url>`: score a pull request's review comments (read-only on GitHub)
- `quiet-review-axi score --findings <file>`: score a generic findings file
- `quiet-review-axi replay`: build the public dataset and run the accuracy test
- `quiet-review-axi report`: print the accuracy summary

Backends: OpenRouter (default) or the TypeSafe API, with your own key.

## Documents

- [docs/spec.md](docs/spec.md): the v0 specification
- [docs/jev-guide.md](docs/jev-guide.md): how the Jev model works and how to build on it

## License

MIT, see [LICENSE](LICENSE).
