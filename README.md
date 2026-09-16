# Decision Makers Finder

This Manifest V3 extension adds a floating **Find the Decision Makers** button to ordinary websites. It keeps the company website open and opens a new Google-search tab for each query, with a 2-second gap between launches. Launches continue independently of earlier tabs loading or being read; there is no three-tab limit.

Each search tab closes after its LinkedIn profile links are collected. Results are deduplicated across all queries. After every query has launched and every search tab has finished, each unique profile opens in its own new tab with a random 10–15 second gap. A live unique-prospect count appears above the Stop button across eligible pages while the queue is running; the Stop button and count disappear when it finishes. A Google verification tab stays open for manual completion while the other queries continue launching; profile opening waits for its results too.

The black popup provides an enable toggle, a one-query-per-line editor, progress text, and Start/Stop controls.

The **LinkedIn** toggle appends `linkedin` to every Google query. Newly launched search tabs become the active tab as they open. Once Google research is complete, every LinkedIn profile opens in a background tab, so the extension never switches away from the user's current tab during profile viewing.
