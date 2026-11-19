# Contributing

Thanks for helping! Keep it simple:

1. **Ideas and bugs:** open an [issue](../../issues). A screenshot and the XDF name help a lot.
2. **Code:** fork, make a branch, open a pull request. Small PRs are easiest to review.
3. **Build:** `./build_app.sh` (Xcode is not needed). If you have an XDF and a BIN, run the self-tests too:
   `MACTUNER_XDF=def.xdf MACTUNER_BIN=stock.bin ./build_app.sh`
4. **UI text:** add new strings to [`Localization/translations_v2.py`](Localization/translations_v2.py) (German text as
   the key, English at least) and run `python3 Localization/translations.py Localization`. It lists the languages that are still missing; that's fine, someone will fill them in.
5. **Never commit** XDF or BIN files of real control units.

That's it. Match the style of the code around you, and don't worry about getting everything perfect.
