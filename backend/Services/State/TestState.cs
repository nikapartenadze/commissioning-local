using IO_Checkout_Tool.SharedComponents;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services.State;

public class TestState
{
    private Io _testTag = new();
    private Io _outputToTestInputTag = new();
    private bool _isTesting = false;

    public bool IsTesting
    {
        get => _isTesting;
        set
        {
            if (_isTesting != value)
            {
                _isTesting = value;
                StateChanged?.Invoke();
            }
        }
    }

    public Io TestTag
    {
        get => _testTag;
        set
        {
            if (_testTag != value)
            {
                _testTag = value;
                StateChanged?.Invoke();
            }
        }
    }

    public Io OutputToTestInputTag
    {
        get => _outputToTestInputTag;
        set
        {
            if (_outputToTestInputTag != value)
            {
                _outputToTestInputTag = value;
                StateChanged?.Invoke();
            }
        }
    }

    public event Action? StateChanged;

    public void Reset()
    {
        IsTesting = false;
        TestTag = new Io();
        OutputToTestInputTag = new Io();
    }

    public void ClearOutputTag()
    {
        OutputToTestInputTag = new Io();
    }
} 