namespace Pupil.Core;

// Shared IDs and heuristics used across collection, labeling, and post-processing.
internal static class PerceptionConstants
{
    // Overlap threshold used by NMS to suppress near-duplicate nodes.
    internal const double IouThreshold = 0.90;
    internal const int TreeScopeSubtree = 7;
    internal const int MaxWindows = 12;
    internal const double MinVisibleRatio = 0.02;

    // UIAutomation property IDs cached during traversal.
    internal const int PropBoundingRect = 30001;
    internal const int PropControlType = 30003;
    internal const int PropName = 30005;
    internal const int PropAcceleratorKey = 30006;
    internal const int PropAccessKey = 30007;
    internal const int PropHasKeyboardFocus = 30008;
    internal const int PropIsKeyboardFocusable = 30009;
    internal const int PropIsEnabled = 30010;
    internal const int PropHelpText = 30013;
    internal const int PropIsOffscreen = 30022;
    internal const int PropItemStatus = 30026;
    internal const int PropValueValue = 30045;
    internal const int PropExpandCollapseState = 30070;
    internal const int PropSelectionItemIsSelected = 30079;
    internal const int PropToggleToggleState = 30086;
    internal const int PropAriaRole = 30101;
    internal const int PropAriaProperties = 30102;

    // UIAutomation pattern IDs requested in the cache.
    internal const int PatternValue = 10002;
    internal const int PatternExpandCollapse = 10005;
    internal const int PatternSelectionItem = 10010;
    internal const int PatternToggle = 10015;

    // Control types prioritized in the final actionable output.
    internal static readonly HashSet<string> InteractiveTypes =
    [
        "ButtonControl",
        "CheckBoxControl",
        "ComboBoxControl",
        "EditControl",
        "HyperlinkControl",
        "RadioButtonControl",
        "TabItemControl",
        "MenuItemControl",
        "ListItemControl",
        "SliderControl",
        "SpinnerControl",
        "SplitButtonControl",
    ];

    // Known low-signal control types.
    internal static readonly HashSet<string> NoiseTypes = ["SeparatorControl"];

    // Mapping from UIA numeric control type ID to readable name.
    internal static readonly Dictionary<int, string> ControlTypeNames = new()
    {
        [50000] = "ButtonControl",
        [50001] = "CalendarControl",
        [50002] = "CheckBoxControl",
        [50003] = "ComboBoxControl",
        [50004] = "EditControl",
        [50005] = "HyperlinkControl",
        [50006] = "ImageControl",
        [50007] = "ListItemControl",
        [50008] = "ListControl",
        [50009] = "MenuControl",
        [50010] = "MenuBarControl",
        [50011] = "MenuItemControl",
        [50012] = "ProgressBarControl",
        [50013] = "RadioButtonControl",
        [50014] = "ScrollBarControl",
        [50015] = "SliderControl",
        [50016] = "SpinnerControl",
        [50017] = "StatusBarControl",
        [50018] = "TabControl",
        [50019] = "TabItemControl",
        [50020] = "TextControl",
        [50021] = "ToolBarControl",
        [50022] = "ToolTipControl",
        [50023] = "TreeControl",
        [50024] = "TreeItemControl",
        [50025] = "CustomControl",
        [50026] = "GroupControl",
        [50027] = "ThumbControl",
        [50028] = "DataGridControl",
        [50029] = "DataItemControl",
        [50030] = "DocumentControl",
        [50031] = "SplitButtonControl",
        [50032] = "WindowControl",
        [50033] = "PaneControl",
        [50034] = "HeaderControl",
        [50035] = "HeaderItemControl",
        [50036] = "TableControl",
        [50037] = "TitleBarControl",
        [50038] = "SeparatorControl",
        [50039] = "SemanticZoomControl",
        [50040] = "AppBarControl",
    };
}
