# THE RED LINE

**Status:** draft 1 · authored by the lore agent · 2026-07-31
**Audience:** the Game Master. Not player-facing. Not shipped to `lore.json`.
**Warning:** this repository is public. Nothing here is *secret*; it is
*unpublished*. Treat "GM-only" as "not written into the game yet", never as
"hidden from anyone who looks."

---

## 0. What this document is

This is the root. Everything else in `lore/` — every chapter, every monster
blurb, every item line, every NPC's grudge — hangs off a claim made here. Cut
the root and the tree dies: the chapters would have to be rewritten, and so
would every entity that references them.

So the red line is deliberately **small at the centre and enormous at the
edges**. The centre is five laws that fit on one page. The edges are unbounded
— ages, peoples, places, arguments, thousands of years of a world nobody has
walked into yet. Add at the edges freely. Change the centre almost never, and
when you do, say so loudly, because it invalidates everything downstream.

The red line answers three questions and refuses to answer a fourth.

1. **What is Nangijala?** (§1–2)
2. **What are its laws?** (§3)
3. **Why is anything at stake?** (§4–6)
4. *What happens at the end?* — deliberately unanswered. See §12.

---

## 1. The one sentence

> **Nangijala is the country on the far side of death; it is built out of what
> the dead still remember; and it is quietly running out of memory.**

Everything below is a consequence of that sentence.

---

## 2. Where this comes from (the inheritance)

The game takes its name from the afterworld in Astrid Lindgren's *The Brothers
Lionheart* — the place you go when you die. That is the **only** inherited
premise, and it is inherited as a *premise*, not as content: no characters, no
valleys, no plot from that book are canon here, and none should be borrowed.
What we take is one idea and one mood.

The idea: **death is a door, not a wall.**

The mood: Lindgren's afterworld is the age of campfires and sagas — a place
that is warm and dangerous at the same time, where the worst thing that can
happen to you is not being hurt. We keep that exactly.

Two things already shipped in the game before any lore existed, and both turn
out to be load-bearing. The red line is built to make them true rather than
explaining them away:

- **Every arrival in Nangijala is announced by a shooting star** crossing the
  sky — the same streak on every player's screen, and stray unnamed stars fall
  on their own through the night. (`WorldRoom.ts`, shipped.)
- **The arrival is announced in words, too**, in every player's chat: *"<name>
  has arrived in Nangijala — a star crosses the sky."* (`WorldScene.ts:2156`.)
  Law I is therefore not a proposal; it is already player-facing text, and the
  lore has to stay compatible with it rather than the other way round.
- **There is a campfire burning at the place where you arrive** —
  the only object from the `objects/` domain the game draws, and the only
  *tended* hand-made thing in the world. (`WorldScene.ts:107`, `648`, shipped.)
  Everything else hand-made that the world draws — wells, archways, obelisks,
  a tree-house, a stone hut, a shrine, benches, gravestones — is standing
  there unattended. One lit fire, and a whole country of ruins.

A world where the dead fall as stars and land beside the one fire somebody is
still tending. That is the whole setting in one image, and it was already on
screen. The lore's job was to notice.

---

## 3. THE FIVE LAWS

These are physics, not metaphor. In Nangijala they are as literal as gravity.

### Law I — The Fall
**Every soul arrives from above, as a star.**

Nobody walks into Nangijala. You fall into it, once, and the whole sky sees you
do it. Arrival is public and unmissable: a streak of light from horizon to
horizon that everyone already here looks up at.

You bring nothing but what you were wearing and what you can still remember.
Most arrivals cannot remember their own name for the first while. The word for
a newcomer is a **starfall**, or just *a new star*. The polite thing to do when
you see one is to go and meet it.

Stars also fall at night with no one inside them that anyone can find — souls
that arrived with nothing left to arrive with. These are **wild stars**, and
they are the sad, ordinary background noise of the world.

### Law II — The Keeping
**What is remembered holds its shape. What is told holds it longer. What
nobody tells goes soft.**

This is the central law and the strangest one. Memory here is not *about* the
world; memory *is* the world's material. A road exists because enough people
remember a road. A mountain is old because a great many dead have agreed on it
for a very long time.

Consequences, all of them load-bearing:

- **Telling is maintenance.** A story told aloud at a fire holds a thing in
  shape better than one person remembering it alone. This is why there are
  fires. This is why there is a fire where you land.
- **Two people can remember differently and both be right.** The world does
  not arbitrate. It builds both. This is why Nangijala contains a Roman
  aqueduct, a wooden windmill, a line of telegraph poles, a carved tiki totem
  and a stone circle in the same afternoon's walk. Every era is here at once,
  because every era's dead are here at once. **Nangijala is not a period. It is
  everyone's period, stacked.**
- **Precision is a different thing from warmth.** A story *written down* holds
  its exact shape forever and stops growing. A story *told* keeps growing and
  drifts. This trade-off is not a footnote; it is the world's main political
  argument. See §5.
- **Nothing here can be created from nothing.** Every object, creature and
  hillside in Nangijala was remembered here by someone. Ask of any new asset:
  *who remembered this, and how well?*

### Law III — The Quiet
**Nothing in Nangijala dies. Things thin.**

You are already dead. That door is behind you and does not open twice. What can
still happen to you is worse and slower: you can be forgotten, including by
yourself, until there is nothing left holding your shape but habit.

The stages are known and have names, and the names are old:

1. **Bright** — you remember who you were, and can say it.
2. **Faded** — the details go. You keep the shape of a life without its
   particulars: you know you loved someone; you cannot produce the face.
3. **Habit** — the person is gone; the behaviour remains. A thing that still
   walks its round, still guards its bridge, still goes home to a house that
   isn't there.
4. **Quiet** — the shape lets go. Nothing violent. It simply stops being
   anywhere.

**Most creatures you meet are stage 3** — something running on habit with
nobody home. This is why they are hostile in a way that isn't personal, why
they don't negotiate, and why nothing in this world calls killing them murder.
(It also calls for a certain restraint in the writing: they should be sad more
often than they are evil.)

*Most*, not all — and the exception matters, because roughly half the roster is
it. The four stages describe what happens to a thing **that was once
somebody**. The Made (§9) never were: there is no occupant to lose, so they do
not fade through the stages at all. They simply hold together for as long as
the remembering they condensed out of stays pooled, and come apart when it
doesn't. A Made thing cannot be sad about itself. It is nevertheless doing
exactly what a thing at stage 3 does, from the outside, which is why nobody
sorts them at a glance and why the field-guides lump them together.

**Being broken is not the Quiet.** A person here can be knocked apart — hurt
past the point of holding a shape — and it is violent and unpleasant and it is
not an ending. What is left goes where remembering is thickest, which in
practice means the nearest tended fire, and pulls itself back together beside
it over some hours. You lose nothing you were carrying and a little of what you
were thinking. This is why a fire is worth keeping lit even in country nobody
lives in, and it is the reason nobody in Nangijala treats a fight as final.

The Quiet, not death and not being broken, is the fear that organises this
world. Every institution, faith, faction and grudge in Nangijala is a different
answer to it.

### Law IV — The Drift
**Nangijala re-remembers itself. It does not stay put.**

The land is held up by the same imperfect remembering as everything else, so
the land moves. Coastlines are approximately where they were. A path you took
last season goes somewhere slightly else. A hill that everyone was sure about
is not there, and nobody can say when it stopped.

Locals call an episode of this a **Turn**. Turns are not disasters; they are
weather on a longer clock. You do not fight a Turn. You re-walk your ground
afterwards and find out what you have.

*(Engineering note — this law is deliberate. The world map in this repo is
regenerated wholesale from rules, monsters appear and vanish with an art tag,
and items get renamed in batches. Law IV makes all of that canon rather than a
contradiction. See `canon/CONSTRAINTS.md` §"The doctrine of loss".)*

### Law V — The Hard Pieces
**When a thinned thing is broken open, the last of its story survives as a
stone.**

Everything a creature was gets thinner and thinner until, at the very end,
there is a single dense thing left that will not thin any further. Break the
shape and it falls out. This is a **soulstone**.

A soulstone is not a soul. It is the last hard piece of one — one fact, one
appetite, one habit of being, compressed until it is nearly a mineral. It is
warm. It does not fade. Of everything that can be picked up in Nangijala, it is
the only thing that is *guaranteed* not to.

With one exception, and the exception is the reason anybody is worried. The
masks the Hollowed leave behind (§9, §10) do not fade either, and nobody put
them through a lifetime to get there. Something is producing unfadeable objects
without the centuries of wear that are supposed to be the whole mechanism. Two
readings are current: that a mask is a hard piece like any other, made the fast
way; or that it is a hard piece of the *same* thing every time. Nobody likes
the second one.

Because it cannot be forgotten, it can be *used*. Carried against a blade or
worked into armour, a soulstone lends its holder some of what it remembers:
a stone from something that burned, burns. A stone from something that endured
the cold, endures it.

Every kind of creature produces exactly one kind of stone, and no two kinds
produce the same one. This is not a rule anyone made. It is simply what it
looks like when a particular way of forgetting reaches the bottom.

The trade in these stones is the economy of the entire world. See §6.

---

## 4. THE THREE AGES

The chapter spine. Player-facing chapters hang here.

### The Age of Coming
The world filling up. Nobody knows the laws yet; they are simply falling into
a place and finding it agreeable, and everything anybody brings turns out to be
real. It is an age of accidental abundance and no maintenance — the great age
of *building*, which is why the ruins are so much better than anything standing
now. Aqueducts get built by people who remember aqueducts. Someone remembers a
lighthouse hard enough that there is a lighthouse, and it still stands in the
shallows with nothing to warn.

It ends when the first things start going soft, and nobody understands why.

### The Age of Fires
Somebody works it out. The discovery is simple enough to be an anticlimax:
**the things people talk about stay.**

What follows is the golden age and the moral high-water mark of Nangijala. The
fires are lit. Fire-keepers walk circuits. There is a rota. New arrivals are
met at their landing, told what has happened to them, and asked — gently, and
early, before it goes — to say their name and one true thing while somebody
listens. Whole districts are held up by a story told well every night by
somebody who is good at it.

It is also the age that produces the argument that breaks it. See §5.

### The Thinning (now)
Fewer fires than circuits. Fewer tellers than fires. The rota is a fiction
maintained by people who will not admit it lapsed. Ground that was held for
centuries goes soft in a season, and there is a hole under the east mountain
that everyone can feel and nobody will walk into twice.

This is where the player lands. **The world is not ending; it is being
forgotten, which is slower and much worse.** Nothing in the player's first hour
should say this out loud. The world should simply feel like a good place that
used to be better, with the fire still lit at the spot where they land, because
somebody is still doing their job.

---

## 5. THE ARGUMENT (the political core)

Law II offers two ways to keep a thing, and they are incompatible. That
incompatibility is the setting's main conflict, and it is a conflict where
**both sides are right**, which is what makes it good material for dialogue.

### The Fire-Keepers (also: tellers)
Keep it warm. A thing told is a thing alive: it grows, it gets embellished, it
adapts, it survives its own inaccuracies. A story told badly is still a story
told. Their weakness is honest and fatal — a told world **drifts**. Retell a
man forty years and you have a different man. Fire-keepers routinely preserve
somebody into someone they were not.

Their creed is short: *say a true thing to somebody who is listening.*

### The Chroniclers
Write it down. Exactly, once, and then it is safe from the retellers. A written
thing is fixed: it will be as accurate in a thousand years as the day it was
set down, and it needs no rota, no successor and no fire. Their weakness is
equally fatal — a written thing is **fixed**. It stops growing. Chroniclers
have discovered, to their considerable distress, that a person recorded
perfectly and then never spoken of again goes Quiet anyway, on schedule, with
a beautiful and complete record of themselves sitting right there.

Nobody has proved *why*. The Fire-Keepers say it is obvious: the point was
never the accuracy, it was the listening.

**Diegetic note, important:** the in-game wiki *is* the Chronicle. When a
player opens it they are reading the Chroniclers' actual work. This is why
missing entries can say, truthfully, that no chronicler has written this one
down yet — and why a gap in our content is a fact about the world rather than a
bug in it. Lean on this. Never break it.

### The third position
There are people who think both parties are rearranging furniture, because the
real answer is to stop needing to be kept at all — to remember yourself
completely and go on to the Long Morning (§7). The Fire-Keepers find this
selfish. The Chroniclers find it unfalsifiable. It is, notably, the only
position that has ever been observed to work.

---

## 6. THE ECONOMY (why an RPG happens here)

Three commodities. All three fall out of the laws; none were invented to make
a game work, and all three happen to make one.

**Stones.** A soulstone cannot be forgotten (Law V), which makes it the only
truly durable thing in a world where durability is the scarce resource. Every
economy needs an anchor; this world's anchor is other people's last memories.
There is no polite way to say this and the setting should not try. The people
who do it for a living have a working vocabulary instead: **releasing** is what
you call it when you mean well, **cracking** is what you call it among your
own, and the distinction between the two words is roughly the whole moral range
of the profession.

**Gold.** Gold is the one thing every dead person, from every era, remembers
*identically*. A coin's worth of gold arrives in the same shape whoever brings
it. That perfect agreement makes it the only substance in Nangijala that never
drifts, tarnishes or thins — and therefore, without anyone deciding it, money.
Nangijala did not choose a currency. It discovered the one object it could not
misremember.

**Junk.** Everything else — teeth, hide, bone, feathers, cracked stone, a
knife somebody carried. Individually worthless, and collected obsessively. Not
for what it is: for what it *is evidence of*. A pile of a creature's leavings
is a story with the details still attached, and details are exactly what the
Quiet takes first. Somebody, somewhere, is buying.

*(Who, exactly, is buying, and what they are doing with it, is the strongest
open hook in the setting. Do not answer it yet.)*

---

## 7. THE LONG MORNING

The aurora is not weather.

Nangijala has a further shore. The dead who manage to remember themselves
completely — not preserved by others, but whole on their own — stop being here,
and go on. Nobody has ever come back to describe it, which the Chroniclers
consider disqualifying and the Fire-Keepers consider the point.

What can be observed: when someone goes on, the northern sky lights. The
tellers call it the **Long Morning**, and they call the lights the far edge of
somebody else's dawn. It happens rarely enough to be an event and often enough
that everyone alive has seen it.

The reason this matters mechanically: **going on is the only good ending
available in this world, and it is available to anyone, and almost nobody takes
it.** Which raises the question the entire NPC cast exists to answer — see §8.

---

## 8. THE RULE FOR EVERY PERSON IN NANGIJALA

The design rule that makes dialogue write itself. Applied to every NPC without
exception:

> **Everyone here could go on to the Long Morning. Everyone here has a reason
> they haven't. Find out the reason and you have found out the person.**

The reasons cluster, and the clusters are the character archetypes:

- **Waiting.** Someone they love has not fallen yet. They will not go on ahead.
  This is the most common reason and the most sympathetic one, and it curdles
  beautifully over a long enough wait.
- **Watching.** Someone they love fell and went *thin*, and they will not leave
  a shape that still has their name in its mouth.
- **Owed.** They did something before they fell. Going on feels like getting
  away with it.
- **Working.** The rota. The fire. If they go on, who meets the next star?
- **Refusing.** They do not believe in it, or they have decided that a world
  which can be lost is worth more than one that can't.
- **Unable.** They have already faded past the point of being able to assemble
  themselves. These are the saddest and are usually not written as NPCs but as
  the reason another NPC is the way they are.

Every NPC gets: a **name**, a **fall** (how they arrived and roughly when),
what they are **waiting on**, what they have **forgotten and know it**, and one
**flaw** that follows from the above. That is enough for anyone to write their
dialogue without asking me.

---

## 9. WHAT THE CREATURES ARE

A taxonomy that costs no new data field, that a player can learn by playing,
and that covers everything on the roster. Three kinds:

**The Come.** Things that fell, because they were alive somewhere. Animals,
mostly — a mammoth, a sabre-tooth, a rabbit, a donkey, a frog. They arrive
whole, and thin exactly like people do, and the ones you meet are running on
habit. There is no cruelty in the world quite like a beast still doing its
round for a keeper who was forgotten before it was.

**The Made.** Things that never fell, because they were never anywhere. Where
remembering pools with nothing to be — leftovers of a hundred thousand
half-recollections with no owner — it thickens and gets up. Stumps that woke.
Boulders that walk. The small round things that appear wherever a place is
over-remembered and under-used. A Made thing has no life behind it, which does
not stop it having a personality; it has *everyone's* faint idea of one.

The Made are also where the world's honest jokes live. A dragon remembered by
somebody who never saw one is the size of a lantern and still breathes fire,
because that part everybody gets right.

**The Hollowed.** Things that were emptied rather than thinned — the fast way,
the wrong way, the thing the cave does. A Hollowed creature keeps the outside
and loses the inside all at once, and what is left wears the shape like a coat.
They are the only creatures in Nangijala that are frightening rather than sad,
and they are the only ones the setting is comfortable calling wrong.

When a Hollowed thing is broken, the mask is what survives. That is not
symbolism. It is the observation that started the entire investigation.

---

## 10. THE HOLE UNDER THE MOUNTAIN

The antagonist. Not a dark lord — the setting does not have room for one and
would be worse with one.

Under the eastern massif there is a cave, and inside it the remembering does
not merely thin, it **goes somewhere**. Ground near it forgets on a clock you
can time with a candle. Things that go in come out Hollowed, or come out
wearing something's face, or do not come out. The nearer you get, the harder it
is to hold a thought you brought with you.

Facts to hold to:

- It is **hungry**, not malevolent. Nothing in the cave hates anybody. That is
  worse.
- It was, very probably, **a person**. Something in there kept enough shape to
  have a preference, and the preference is *more*.
- **The masks are its work.** They are what it leaves when it takes the inside
  of something. They keep smiling because a face is the easiest part of a
  person to remember and the last part to go.
- It is **new**. The Age of Fires had no hole. Somebody made this, or became
  it, and it happened recently enough that there are people still walking
  around who remember when the east road was safe.

**Deliberately unanswered:** who it was, whether it can be reasoned with, and
whether it is a wound in the world or the world's own immune reaction to being
over-remembered. Do not answer these until the game can dramatise the answer.
An answered mystery is a spent one.

---

## 11. THE SHAPE OF THE WORLD

Geography is described here **only** by relation and character, never by
coordinate, because Law IV means coordinates are a lie. (The world map in this
repo is regenerated from rules and moves whenever it is rebuilt.)

- **The high ground, north and behind everything.** The mountain: stone, then
  snow, then ice, and at the very top the crystal country where things do not
  thin because nothing up there ever gets warm enough to change. The oldest and
  best-agreed part of the world. Also the emptiest.
- **The black rock.** A stretch of the massif that is wrong-coloured and warm
  underfoot. Nothing agrees about why. It is where the fire-natured things live
  and where the cave's influence surfaces.
- **The cave, under the east massif.** See §10. One mouth. Everyone knows where
  it is.
- **The gorge**, splitting the massif, crossed high in several places. The
  crossings are guarded, in the way that a thing running on habit guards
  something — which is to say the guard is still there and whatever posted it
  is not.
- **The Trollstigen**, the switchback stair down the mountain wall — the only
  honest way down, named by somebody who brought the name with them from a
  country that had one.
- **The maze and the meadows**, low and near, where the ground is soft in both
  senses: easy walking, and thin. This is the part of Nangijala that changes
  most between Turns.
- **The lowland water** — a lake basin that keeps the sky in it, sunken
  hollows, walk-in lagoons high on the snow that have no business being there.
- **The shore**, on the near side only, sand and wreck and the things the sea
  gives back. Nobody lives on it. Everyone visits it.
- **The ocean**, in every direction, which nobody has crossed, and which is not
  where the Long Morning is.

And one building: **a small stone house on the meadow with a black roof, one
door, and a fire burning outside it.** It is the first thing a new star sees.
Somebody built it to be exactly that and is not necessarily still around.
Naming it, and finding out who kept it, is the first piece of story the game
should be able to tell.

---

## 12. WHAT THE RED LINE REFUSES TO SAY

Held open on purpose. Each of these is worth more unanswered than answered, and
each should stay unanswered until the game can *play* the answer rather than
print it.

1. What the Long Morning is, and whether the aurora is really what the tellers
   say it is.
2. Who or what is in the cave.
3. Who buys the junk, and what they are building out of it.
4. Whether the Made can go on to the Long Morning, having never had a life to
   remember. (The Fire-Keepers say yes. Nobody has seen it.)
5. Whether anyone has ever arrived in Nangijala who was not dead.
6. What happens to a soulstone when its holder goes on.
7. Whether the world is running out of memory because there are fewer tellers —
   or because something is taking it. Both are currently believed by serious
   people.

---

## 13. HOUSE RULES FOR EVERY WORD WE SHIP

1. **Never explain the laws to the player directly.** The player should learn
   Law III by meeting a bridge-guard that will not stop guarding a bridge. A
   chapter may state a law; a monster blurb never should.
2. **Sad before evil.** Default emotional register for creatures is loss, not
   menace. The Hollowed are the exception and their scarcity is what makes them
   land.
3. **Concrete over cosmic.** The setting is enormous; the writing is small. A
   fire, a rota, a name somebody can't produce. No prose about destiny.
4. **Match the art, always.** If the sprite is a lantern-sized dragon, the lore
   says lantern-sized. Art wins every disagreement, because art is the thing
   that shipped.
5. **No proper nouns in per-entity blurbs** unless the noun is canon elsewhere
   in the repo. Entity blurbs are short and get rewritten by other agents;
   proper nouns in them are how contradictions get made.
6. **Every entity's lore answers one of the five laws.** If it doesn't, it is
   flavour text, not lore, and it will not survive the next rewrite.
7. **Assume everything will be deleted.** Write so that the world survives the
   removal of any one thing in it. See the doctrine of loss.

---

## 14. VERSION

| version | date | change | invalidates |
|---|---|---|---|
| draft 1 | 2026-07-31 | first authored red line: five laws, three ages, the argument, the economy, the taxonomy, the cave | — (nothing downstream yet) |

Anything that changes §3 is a **root change** and requires re-reading every
chapter and every entity file. Anything that changes §4–§11 is a **branch
change** and requires re-reading the chapters that touch it. §12 may be
narrowed at any time; narrowing it is how the game grows.
