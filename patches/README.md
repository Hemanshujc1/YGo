# Native dependency patches

## react-native-screens 4.26.0 (#402)

Expo SDK 57 pins screens to `~4.26.0`. On Android, concurrent initialization can
free a Fabric mounting override delegate while React Native still uses it,
causing a cold-launch SIGSEGV in `MountingCoordinator::pullTransaction`.

`react-native-screens@4.26.0.patch` backports the complete four-file fix from
[upstream #4413](https://github.com/software-mansion/react-native-screens/pull/4413),
merge commit `b3badd012f83679b12f4e29f2e28eceaa4830efd`. The only adaptation is
mapping upstream's `cpp/legacy/` paths to `cpp/`, where 4.26.0 keeps these files.
It retains the process-lifetime listener, synchronized callback installation and
invalidation, and ownership tokens that protect a newer React host's callback.
Both Android apps must be rebuilt; a Metro reload does not apply native patches.

The first stable release containing the fix is
[4.28.0](https://github.com/software-mansion/react-native-screens/releases/tag/4.28.0).
Remove this patch and its `patchedDependencies` entry when a supported Expo SDK
pins screens to 4.28.0 or newer and includes #4413. Regenerate the lockfile, rebuild
both Android apps, repeat the cold-launch and airport checks, and run the gate.
Track removal in [#404](https://github.com/Hemanshujc1/YGo/issues/404).
