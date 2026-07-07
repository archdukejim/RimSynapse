using HarmonyLib;
using Verse;

namespace RimSynapse.Patches
{
    /// <summary>
    /// Harmony patch on Root.Shutdown for clean teardown.
    /// Disposes HTTP client, stops timers, flushes queue.
    /// </summary>
    [HarmonyPatch(typeof(Root), nameof(Root.Shutdown))]
    internal static class Root_Shutdown_Patch
    {
        static void Prefix()
        {
            SynapseCore.Shutdown();
        }
    }
}
