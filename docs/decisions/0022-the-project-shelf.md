# 0022 — The project shelf is a function, not an afternoon

**Status:** accepted, 2026-10-13.

## The problem

`ANUAL_SUMMIT_..._leftwind_v006.aep` had 28 compositions and every piece of
footage loose in the project root. Nothing was wrong with it. Nothing could be
found in it either: the live `Car01` sat next to the `Car01 Comp 1` it was
precomposed from, next to six one-layer bunting strands, next to the
superseded `GYG_Sides-Left_v001`, in whatever order After Effects had happened
to add them.

The obvious fix is to spend twenty minutes dragging items into folders. The
reason not to is that it does not last. The next generated clip lands in the
root. The next entity gets precomposed to `Something01 Comp 1` in the root.
A month later the project looks exactly as it did, and the twenty minutes buys
nothing except the knowledge that it will have to be spent again.

## The decision

The shelf is **a pure function from an inventory to a set of moves**, in
`packages/domain/src/projectShelf.ts`, applied by a script that is a dry run
by default (`scripts/tidy-project.ts`).

```
00_DELIVERY/      the comps that get rendered — newest version of each surface
10_ELEMENTS/
    Car01/
        Car01             the live comp
        01_source/        the PSD grouping it was precomposed from
        02_stills/        captured plates
        03_clips/         generated footage
20_GENERIC/
    bunting/  clouds/  plates/  Solids/  footage/
90_ARCHIVE/       superseded versions, kept rather than deleted
SEED/             the host's import inbox, left at the root on purpose
```

Numbered because the Project panel sorts alphabetically, and there is no other
way to make delivery sit above elements.

Three new host commands carry it out, and they decide nothing:
`projectItems` reports the inventory, `createFolders` makes folders by path
idempotently, `moveItems` moves items into them. Every judgement about what
belongs where is in the domain package, where it is 23 tests rather than a
habit.

## Why the rule lives in TypeScript and not in ExtendScript

The same reason the pinning table had to be measured rather than guessed: a
rule nobody can test is a rule that is wrong in a way nobody notices. Two bugs
were found by the tests before this was ever pointed at a project — a
placeholder named `Car01 pending` was being filed as a still of `Car01`
(hiding the fact that a render was still owed), and an element whose only item
was its PSD grouping never got the folder above it created.

Neither would have been visible in a project panel. Both were one assertion.

## What it deliberately does not do

- **It does not delete.** `90_ARCHIVE` is where superseded work goes.
  `GYG_Sides-Left_v001` is archived, not removed, and the disabled superseded
  layers inside the entity comps are left alone.
- **It does not guess at renames.** `Rooftop01 Comp 1` is the rooftop crowd as
  it came out of the PSD; the animated version was rebuilt as `PartyCrew01`.
  Nothing in the project records that link, their sizes match and their names
  do not, so the grouping is filed under its own key with a reason that says
  what it is. Inferring the mapping from a size match would be a guess about
  the artwork dressed up as a fact about the project.
- **It does not sweep.** Items no rule claims are reported as `unsorted` and
  left exactly where they are. A folder called `misc` is how a flat project
  comes back.
- **It does not fail a batch over one stale id.** An item id is a
  project-session number, so every move carries the name the plan was built
  from and the host refuses the ones that no longer agree. Thirty good moves
  should not be undone by one item somebody renamed while the plan was being
  printed.

## What the first dry run caught

Pointed at the real project, the first version of these rules wanted **326
moves out of 333 items**. The flatness was never 333 items deep: only 36 were
loose. The other 297 were already grouped -- After Effects puts a layered
PSD's layers in a `<name> Layers` folder of its own, and the host puts
generated media in `SEED`. Both are better than any drawer this could invent,
and the rules were about to empty all of them into `20_GENERIC/footage` and
`20_GENERIC/plates`.

So a drawer is moved by its handle. Footage already inside a folder is only
moved when it positively belongs to an element; a `<name> Layers` folder is
placed as a unit, and goes to `90_ARCHIVE` when the comp it belongs to did.

Applied to `..._leftwind_tidy_v007.aep`: 28 folders made, 35 items moved, 297
left alone, 0 refused, 0 unsorted. A re-read afterwards wanted no further
moves and found nothing but folders in the root.

This is the argument for the dry run being the default, and for the plan
printing the rule that placed each item -- "326 moves" was readable as wrong
in about four seconds. Inside a project panel it would have been an afternoon
of dragging things back.

## The property that matters

Re-running it on a sorted project asks for nothing. That is tested
(`running it a second time`), and it is the whole difference between a
convention and an afternoon.
