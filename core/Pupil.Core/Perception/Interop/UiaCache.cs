using UIA = Interop.UIAutomationClient;

namespace Pupil.Core;

// Builds a UIA cache request and traverses cached elements to produce normalized RawNode records.
internal static class UiaCache
{
    /// <summary>
    /// Create the shared UIA cache request used during full-window traversal.
    /// </summary>
    /// <returns>
    /// Tuple of automation root object and a cache request preloaded with required properties/patterns.
    /// </returns>
    internal static (UIA.IUIAutomation automation, UIA.IUIAutomationCacheRequest cacheRequest) BuildCacheRequest()
    {
        // CUIAutomation8 enables modern UIA access while preserving COM-based cache traversal.
        UIA.IUIAutomation automation = new UIA.CUIAutomation8();
        var cr = automation.CreateCacheRequest();
        // Cache all properties used by labeling/filtering so traversal avoids live cross-process calls.
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

    /// <summary>
    /// Traverse cached descendants depth-first and append visible normalized nodes.
    /// </summary>
    /// <returns>
    /// Total number of descendants under the current element, used as a post-process hint.
    /// </returns>
    internal static int WalkCached(UIA.IUIAutomationElement element, List<RawNode> raw, List<RectI> clipRegions, int depth = 0, string? inheritedLabel = null)
    {
        if (!TryGetCachedBoundingRect(element, out var brect))
        {
            return 0;
        }

        var ctypeId = Convert.ToInt32(CachedProp(element, PerceptionConstants.PropControlType) ?? 0);
        // Fallback to numeric ID string when control type is unknown to our mapping table.
        var ctype = PerceptionConstants.ControlTypeNames.TryGetValue(ctypeId, out var found) ? found : ctypeId.ToString();

        // Clip each element to the best matching visible region of the hosting top-level window.
        var (rx, ry, rw, rh) = Geometry.ClipRectToRegions(
            brect.Left,
            brect.Top,
            brect.Right - brect.Left,
            brect.Bottom - brect.Top,
            clipRegions);

        var isVisible = rw > 0 && rh > 0;
        // Child nodes inherit parent/type label when they do not expose a usable own label.
        var ownLabel = isVisible ? NodeLabelCached(element, inheritedLabel is null ? ctype : null) : null;
        var closestLabel = ownLabel ?? inheritedLabel;

        // Count descendants while traversing children depth-first; used later during post-processing.
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
            // Depth and descendant count are consumed by post-processing prioritization rules.
            raw.Add(new RawNode(ctype, closestLabel ?? ctype, new RectOut(rx, ry, rw, rh), depth, totalDesc));
        }

        return totalDesc;
    }

    /// <summary>
    /// Read a cached UIA property and normalize missing/blank values to null.
    /// </summary>
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

    /// <summary>
    /// Build a human-readable label from cached name/help/state with contextual fallback.
    /// </summary>
    private static string? NodeLabelCached(UIA.IUIAutomationElement element, string? fallbackLabel)
    {
        // Prefer semantic names, then help text, and finally carry contextual fallback from parent/type.
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
            // Append concise interaction state (enabled/selected/value/etc.) for better downstream prompts.
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

    /// <summary>
    /// Build compact state tokens from cached UIA properties.
    /// </summary>
    private static List<string> NodeStateTokensCached(UIA.IUIAutomationElement element)
    {
        // Build a compact state vector from cached properties to avoid extra pattern calls.
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
            // ToggleState uses UIA enum values 0/1/2; keep readable labels in output.
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
            // ExpandCollapseState values are normalized to compact textual state tokens.
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

    /// <summary>
    /// Try to read cached element bounding rectangle.
    /// </summary>
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

    /// <summary>
    /// Convert mixed UIA boolean/int values to a managed boolean.
    /// </summary>
    private static bool ToBool(object value) => value switch
    {
        bool b => b,
        _ => Convert.ToInt32(value) != 0
    };

    /// <summary>
    /// Convert nullable values to non-null strings.
    /// </summary>
    private static string SafeToString(object? value) => value?.ToString() ?? string.Empty;

    /// <summary>
    /// Trim and truncate arbitrary property values for compact label output.
    /// </summary>
    private static string TrimValue(object value, int maxLen = 32)
    {
        // Normalize line breaks so labels remain one-line and tool-friendly.
        var text = SafeToString(value).Trim().Replace("\n", " ");
        return text.Length <= maxLen ? text : text[..(maxLen - 1)] + "…";
    }
}
