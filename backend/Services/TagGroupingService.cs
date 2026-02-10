using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace IO_Checkout_Tool.Services;

/// <summary>
/// Analyzes PLC tag names and groups boolean I/O points by their parent DINT tag.
///
/// Allen-Bradley CompactLogix Point I/O modules store discrete I/O as bits within DINTs:
///   EPZ_PS2_FIO1:I.Pt00.Data = bit 0 of EPZ_PS2_FIO1:I.Data (a DINT)
///   EPZ_PS2_FIO1:I.Pt01.Data = bit 1 of EPZ_PS2_FIO1:I.Data
///   EPZ_PS2_FIO1:I.Pt15.Data = bit 15 of EPZ_PS2_FIO1:I.Data
///
/// By reading the parent DINT once, we get all 32 bit values in a single CIP request,
/// instead of sending 32 separate requests for each boolean point.
/// </summary>
public static class TagGroupingService
{
    /// <summary>
    /// Regex pattern matching Allen-Bradley Point I/O tag naming:
    /// Module:IODirection.PtNN.Data
    /// Groups: 1=Module, 2=IODirection(I or O), 3=PointNumber
    /// </summary>
    private static readonly Regex PointDataPattern = new(
        @"^(.+):([IO])\.Pt(\d{2,3})\.Data$",
        RegexOptions.Compiled);

    /// <summary>
    /// Represents a group of IO points that share a parent DINT tag
    /// </summary>
    public class TagGroup
    {
        /// <summary>Parent DINT tag path (e.g., "EPZ_PS2_FIO1:I.Data")</summary>
        public string ParentTagPath { get; set; } = string.Empty;

        /// <summary>Mapping of bit offset → original IO tag name</summary>
        public Dictionary<int, string> BitToIoName { get; set; } = new();
    }

    /// <summary>
    /// Result of tag grouping analysis
    /// </summary>
    public class GroupingAnalysis
    {
        /// <summary>Groups of tags that can be read as DINTs</summary>
        public List<TagGroup> Groups { get; set; } = new();

        /// <summary>Tag names that could not be grouped (read individually)</summary>
        public List<string> UngroupedTagNames { get; set; } = new();

        /// <summary>Total original tag count before grouping</summary>
        public int TotalOriginalTags { get; set; }

        /// <summary>Number of DINT reads needed (one per group)</summary>
        public int TotalDintReads => Groups.Count;

        /// <summary>Number of individual reads still needed</summary>
        public int TotalIndividualReads => UngroupedTagNames.Count;

        /// <summary>Total reads after optimization</summary>
        public int TotalOptimizedReads => TotalDintReads + TotalIndividualReads;

        /// <summary>Reduction ratio (e.g., 25.0 means 25x fewer reads)</summary>
        public double ReductionRatio => TotalOriginalTags > 0 && TotalOptimizedReads > 0
            ? (double)TotalOriginalTags / TotalOptimizedReads
            : 1.0;
    }

    /// <summary>
    /// Analyze a list of tag names and determine which can be grouped by parent DINT.
    /// Tags matching the pattern Module:IO.PtNN.Data with point numbers 0-31 are grouped.
    /// All other tags remain as individual reads.
    /// </summary>
    public static GroupingAnalysis Analyze(List<string> tagNames, ILogger? logger = null)
    {
        var analysis = new GroupingAnalysis { TotalOriginalTags = tagNames.Count };

        // Parse and group by parent DINT path
        var groups = new Dictionary<string, List<(string tagName, int bitOffset)>>();
        var ungrouped = new List<string>();

        foreach (var tagName in tagNames)
        {
            var match = PointDataPattern.Match(tagName);
            if (match.Success)
            {
                var module = match.Groups[1].Value;
                var ioDirection = match.Groups[2].Value;
                var pointNumber = int.Parse(match.Groups[3].Value);

                // Only group points 0-31 (fits in one DINT)
                if (pointNumber < 32)
                {
                    var parentPath = $"{module}:{ioDirection}.Data";

                    if (!groups.ContainsKey(parentPath))
                        groups[parentPath] = new List<(string, int)>();

                    groups[parentPath].Add((tagName, pointNumber));
                }
                else
                {
                    // Point number >= 32 doesn't fit in first DINT, keep as individual
                    ungrouped.Add(tagName);
                    logger?.LogDebug("Tag {TagName} has point number {Point} >= 32, keeping as individual read", tagName, pointNumber);
                }
            }
            else
            {
                // Doesn't match Point I/O pattern, keep as individual
                ungrouped.Add(tagName);
            }
        }

        // Convert groups to TagGroup objects (only groups with 2+ members are worth grouping)
        foreach (var (parentPath, members) in groups)
        {
            if (members.Count >= 2)
            {
                var tagGroup = new TagGroup
                {
                    ParentTagPath = parentPath,
                    BitToIoName = members.ToDictionary(m => m.bitOffset, m => m.tagName)
                };
                analysis.Groups.Add(tagGroup);
            }
            else
            {
                // Single tag in group - not worth the overhead, keep as individual
                ungrouped.AddRange(members.Select(m => m.tagName));
            }
        }

        analysis.UngroupedTagNames = ungrouped;

        logger?.LogInformation(
            "Tag grouping analysis: {Total} tags → {Groups} DINT groups ({GroupedTags} tags) + {Individual} individual = {OptimizedTotal} total reads ({Ratio:F1}x reduction)",
            analysis.TotalOriginalTags,
            analysis.TotalDintReads,
            analysis.TotalOriginalTags - analysis.TotalIndividualReads,
            analysis.TotalIndividualReads,
            analysis.TotalOptimizedReads,
            analysis.ReductionRatio);

        return analysis;
    }
}
