using UIA = Interop.UIAutomationClient;

namespace Pupil.Core;

internal static class UiaCache
{
    internal static (UIA.IUIAutomation automation, UIA.IUIAutomationCacheRequest cacheRequest) BuildCacheRequest()
    {
        UIA.IUIAutomation automation = new UIA.CUIAutomation8();
        var cr = automation.CreateCacheRequest();
        foreach (var prop in new[]
                 {
                     PerceptionConstants.PropBoundingRect, PerceptionConstants.PropControlType, PerceptionConstants.PropName,
                     PerceptionConstants.PropAcceleratorKey, PerceptionConstants.PropAccessKey,
                     PerceptionConstants.PropHasKeyboardFocus, PerceptionConstants.PropIsKeyboardFocusable,
                     PerceptionConstants.PropIsEnabled, PerceptionConstants.PropHelpText, PerceptionConstants.PropIsOffscreen,
                     PerceptionConstants.PropItemStatus, PerceptionConstants.PropValueValue, PerceptionConstants.PropExpandCollapseState,
                     PerceptionConstants.PropSelectionItemIsSelected, PerceptionConstants.PropToggleToggleState,
                     PerceptionConstants.PropAriaRole, PerceptionConstants.PropAriaProperties
                 })
        {
            cr.AddProperty(prop);
        }

        foreach (var pattern in new[]
                 {
                     PerceptionConstants.PatternValue, PerceptionConstants.PatternExpandCollapse,
                     PerceptionConstants.PatternSelectionItem, PerceptionConstants.PatternToggle
                 })
        {
            cr.AddPattern(pattern);
        }

        cr.TreeScope = (UIA.TreeScope)PerceptionConstants.TreeScopeSubtree;
        return (automation, cr);
    }

    internal static int WalkCached(UIA.IUIAutomationElement element, List<RawNode> raw, List<RectI> clipRegions, int depth = 0, string? inheritedLabel = null)
    {
        if (!TryGetCachedBoundingRect(element, out var brect))
        {
            return 0;
        }

        var ctypeId = Convert.ToInt32(CachedProp(element, PerceptionConstants.PropControlType) ?? 0);
        var ctype = PerceptionConstants.ControlTypeNames.TryGetValue(ctypeId, out var found) ? found : ctypeId.ToString();

        var (rx, ry, rw, rh) = Geometry.ClipRectToRegions(
            brect.Left,
            brect.Top,
            brect.Right - brect.Left,
            brect.Bottom - brect.Top,
            clipRegions);

        var isVisible = rw > 0 && rh > 0;
        var ownLabel = isVisible ? NodeLabelCached(element, inheritedLabel is null ? ctype : null) : null;
        var closestLabel = ownLabel ?? inheritedLabel;

        var totalDesc = 0;
        try
        {
            var children = element.GetCachedChildren();
            if (children is not null)
            {
                for (var i = 0; i < children.Length; i++)
                {
                    var child = children.GetElement(i);
                    totalDesc += 1 + WalkCached(child, raw, clipRegions, depth + 1, closestLabel);
                }
            }
        }
        catch
        {
            // Ignore child traversal errors.
        }

        if (isVisible)
        {
            raw.Add(new RawNode(ctype, closestLabel ?? ctype, new RectOut(rx, ry, rw, rh), depth, totalDesc));
        }

        return totalDesc;
    }

    private static object? CachedProp(UIA.IUIAutomationElement element, int propId)
    {
        try
        {
            var value = element.GetCachedPropertyValue(propId);
            if (value is null)
            {
                return null;
            }
            if (value is string s && string.IsNullOrWhiteSpace(s))
            {
                return null;
            }

            return value;
        }
        catch
        {
            return null;
        }
    }

    private static string? NodeLabelCached(UIA.IUIAutomationElement element, string? fallbackLabel)
    {
        var name = SafeToString(CachedProp(element, PerceptionConstants.PropName));
        var helpText = SafeToString(CachedProp(element, PerceptionConstants.PropHelpText));

        string? baseText = (!string.IsNullOrWhiteSpace(name), !string.IsNullOrWhiteSpace(helpText)) switch
        {
            (true, true) => $"{name} ({helpText})",
            (true, false) => name,
            (false, true) => helpText,
            _ => null
        };

        var tokens = NodeStateTokensCached(element);
        if (tokens.Count > 0)
        {
            var suffix = string.Join(", ", tokens);
            if (suffix.Length > 120)
            {
                suffix = suffix[..119] + "…";
            }
            if (!string.IsNullOrWhiteSpace(baseText))
            {
                return $"{baseText} ({suffix})";
            }
            if (!string.IsNullOrWhiteSpace(fallbackLabel))
            {
                return $"{fallbackLabel} ({suffix})";
            }
            return $"({suffix})";
        }

        return baseText ?? fallbackLabel;
    }

    private static List<string> NodeStateTokensCached(UIA.IUIAutomationElement element)
    {
        var tokens = new List<string>();

        var isEnabled = CachedProp(element, PerceptionConstants.PropIsEnabled);
        if (isEnabled is not null)
        {
            tokens.Add(ToBool(isEnabled) ? "enabled" : "disabled");
        }

        var isFocusable = CachedProp(element, PerceptionConstants.PropIsKeyboardFocusable);
        if (isFocusable is not null)
        {
            tokens.Add(ToBool(isFocusable) ? "focusable" : "not-focusable");
        }

        var hasFocus = CachedProp(element, PerceptionConstants.PropHasKeyboardFocus);
        if (hasFocus is not null && ToBool(hasFocus))
        {
            tokens.Add("focused");
        }

        var toggleState = CachedProp(element, PerceptionConstants.PropToggleToggleState);
        if (toggleState is not null)
        {
            var ts = Convert.ToInt32(toggleState);
            tokens.Add(ts switch { 0 => "off", 1 => "on", 2 => "indeterminate", _ => $"toggle={ts}" });
        }

        var isSelected = CachedProp(element, PerceptionConstants.PropSelectionItemIsSelected);
        if (isSelected is not null)
        {
            tokens.Add(ToBool(isSelected) ? "selected" : "unselected");
        }

        var expandState = CachedProp(element, PerceptionConstants.PropExpandCollapseState);
        if (expandState is not null)
        {
            var es = Convert.ToInt32(expandState);
            tokens.Add(es switch { 0 => "collapsed", 1 => "expanded", 2 => "partially-expanded", 3 => "leaf", _ => $"expand={es}" });
        }

        var value = CachedProp(element, PerceptionConstants.PropValueValue);
        if (value is not null)
        {
            tokens.Add($"value={TrimValue(value)}");
        }

        var offscreen = CachedProp(element, PerceptionConstants.PropIsOffscreen);
        if (offscreen is not null && ToBool(offscreen))
        {
            tokens.Add("offscreen");
        }

        var ariaRole = CachedProp(element, PerceptionConstants.PropAriaRole);
        if (ariaRole is not null)
        {
            tokens.Add($"aria_role={TrimValue(ariaRole)}");
        }

        var ariaProps = CachedProp(element, PerceptionConstants.PropAriaProperties);
        if (ariaProps is not null)
        {
            tokens.Add($"aria_props={TrimValue(ariaProps)}");
        }

        var itemStatus = CachedProp(element, PerceptionConstants.PropItemStatus);
        if (itemStatus is not null)
        {
            tokens.Add($"status={TrimValue(itemStatus)}");
        }

        var accessKey = CachedProp(element, PerceptionConstants.PropAccessKey);
        if (accessKey is not null)
        {
            tokens.Add($"access={TrimValue(accessKey)}");
        }

        var accelKey = CachedProp(element, PerceptionConstants.PropAcceleratorKey);
        if (accelKey is not null)
        {
            tokens.Add($"accel={TrimValue(accelKey)}");
        }

        return tokens.Distinct().ToList();
    }

    private static bool TryGetCachedBoundingRect(UIA.IUIAutomationElement element, out RectI rect)
    {
        rect = default;
        try
        {
            var raw = element.CachedBoundingRectangle;
            rect = new RectI(raw.left, raw.top, raw.right, raw.bottom);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool ToBool(object value) => value switch
    {
        bool b => b,
        _ => Convert.ToInt32(value) != 0
    };

    private static string SafeToString(object? value) => value?.ToString() ?? string.Empty;

    private static string TrimValue(object value, int maxLen = 32)
    {
        var text = SafeToString(value).Trim().Replace("\n", " ");
        return text.Length <= maxLen ? text : text[..(maxLen - 1)] + "…";
    }
}
