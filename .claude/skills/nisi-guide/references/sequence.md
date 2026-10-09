# Sequence

A `Sequence` is a swimlane: lanes (who or what does the work) against time. It earns its place when the change is about **ordering, timing or request flow**, and a before/after of that ordering is the clearest way to say it: "the page used to wait on N sequential calls, now it renders first and fills in".

Skip it when the change is about structure or behaviour with no interesting order: a refactor, a new field, a copy change, a new screen. A Sequence nobody needed is clutter above the `Areas`; the lead sentence and bullets are enough.

## API

```mdx
<Sequence title="Opening a repository's page" lanes={["Sidecar", "Page"]}>
  <Before caption="Nothing shows until every PR's state has been fetched.">
    <Step lane="Sidecar" area="fetching" span={8}>get: gh pr view × every session</Step>
    <Wait lane="Page" span={8} />
    <Step lane="Page" area="ui" span={2}>everything renders</Step>
  </Before>
  <After caption="The page renders as soon as get answers; each tick is a sessionStates event.">
    <Step lane="Sidecar" area="fetching" span={1}>get</Step>
    <Step lane="Sidecar" area="fetching" span={2}>gh pr list</Step>
    <Step lane="Sidecar" area="fetching" span={4}>gh pr view × missed only</Step>
    <Wait lane="Page" span={1} />
    <Step lane="Page" area="ui" span={2}>renders now</Step>
    <Event lane="Page" area="ui" at={4} />
    <Event lane="Page" area="ui" at={5} />
  </After>
</Sequence>
```

- `lanes`: the row names. Every `lane` below must be one of them.
- `Step { lane, span, area? }`: work in a lane. Steps and waits in a lane lay out left to right in the order written, so the position of a step is the sum of the spans before it in that lane. `span` is a relative width; **nothing is to scale**, so pick small whole numbers that show the proportions you mean.
- `Wait { lane, span }`: the lane is idle (striped). Use it to hold a lane back until another lane's step is done, as the "Page" lane above waits for `get`.
- `Event { lane, at, area? }`: a tick mark, `at` measured from the left edge in the same units as `span`.
- `area`: the `id` of an `Area`. It sets the step's color to that card's, and hovering the card dims every other area's steps. `validate.ts` reports an `area` that no `Area` has.
- `Before` / `After`: each takes an optional `caption`, the one line under the lanes. With both present the reader gets a Before/After toggle that opens on After; with one, there is no toggle.
- Keep labels short; a step's text is cut off to fit its width.
