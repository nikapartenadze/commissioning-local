using IO_Checkout_Tool.Constants;

namespace IO_Checkout_Tool.Services.State;

public class GraphState
{
    private readonly double[] _data = new double[3];
    private readonly string[] _labels = new string[3];
    private readonly int[] _counts = new int[3];

    public int[] Counts => _counts;
    public double[] Data => _data;
    public string[] Labels => _labels;

    public event Action? StateChanged;

    public void UpdateGraphData(int[] counts, double[] data, string[] labels)
    {
        if (counts.Length == 3 && data.Length == 3 && labels.Length == 3)
        {
            Array.Copy(counts, _counts, 3);
            Array.Copy(data, _data, 3);
            Array.Copy(labels, _labels, 3);
            StateChanged?.Invoke();
        }
    }

    public void UpdateData(int passedCount, int failedCount, int notTestedCount, int totalCount)
    {
        _counts[MathConstants.GraphIndices.PASSED_INDEX] = passedCount;
        _counts[MathConstants.GraphIndices.FAILED_INDEX] = failedCount;
        _counts[MathConstants.GraphIndices.NOT_TESTED_INDEX] = notTestedCount;

        var passedPercentage = Math.Round((float)passedCount * MathConstants.PERCENTAGE_MULTIPLIER / totalCount, MathConstants.DECIMAL_PRECISION);
        var failedPercentage = Math.Round((float)failedCount * MathConstants.PERCENTAGE_MULTIPLIER / totalCount, MathConstants.DECIMAL_PRECISION);
        var notTestedPercentage = Math.Round((float)notTestedCount * MathConstants.PERCENTAGE_MULTIPLIER / totalCount, MathConstants.DECIMAL_PRECISION);

        _data[MathConstants.GraphIndices.PASSED_INDEX] = passedPercentage;
        _data[MathConstants.GraphIndices.FAILED_INDEX] = failedPercentage;
        _data[MathConstants.GraphIndices.NOT_TESTED_INDEX] = notTestedPercentage;

        _labels[MathConstants.GraphIndices.PASSED_INDEX] = $"Passed: {passedCount} ({passedPercentage.ToString(MathConstants.PERCENTAGE_FORMAT)}%) ";
        _labels[MathConstants.GraphIndices.FAILED_INDEX] = $"Failed: {failedCount} ({failedPercentage.ToString(MathConstants.PERCENTAGE_FORMAT)}%)";
        _labels[MathConstants.GraphIndices.NOT_TESTED_INDEX] = $"Not Tested: {notTestedCount} ({notTestedPercentage.ToString(MathConstants.PERCENTAGE_FORMAT)}%)";

        StateChanged?.Invoke();
    }

    public void Reset()
    {
        Array.Clear(_counts, 0, _counts.Length);
        Array.Clear(_data, 0, _data.Length);
        Array.Clear(_labels, 0, _labels.Length);
        StateChanged?.Invoke();
    }
} 