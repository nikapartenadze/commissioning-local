using IO_Checkout_Tool.Constants;

namespace IO_Checkout_Tool.Services.State;

public class UiState
{
    private string _testButtonStyle = TestConstants.Styles.TEST_BUTTON_GREEN;
    private string _passAnimation = TestConstants.Styles.PASS_ANIMATION_HIDDEN;
    private bool _showTable = false;
    private bool _showGraph = false;
    private bool _disableDialog = false;
    private bool _downPressed = false;
    private bool _outputToTestInput = false;

    public string TestButtonStyle
    {
        get => _testButtonStyle;
        set
        {
            if (_testButtonStyle != value)
            {
                _testButtonStyle = value;
                StateChanged?.Invoke();
            }
        }
    }

    public string PassAnimation
    {
        get => _passAnimation;
        set
        {
            if (_passAnimation != value)
            {
                _passAnimation = value;
                StateChanged?.Invoke();
            }
        }
    }

    public bool ShowTable
    {
        get => _showTable;
        set
        {
            if (_showTable != value)
            {
                _showTable = value;
                StateChanged?.Invoke();
            }
        }
    }

    public bool ShowGraph
    {
        get => _showGraph;
        set
        {
            if (_showGraph != value)
            {
                _showGraph = value;
                StateChanged?.Invoke();
            }
        }
    }

    public bool DisableDialog
    {
        get => _disableDialog;
        set
        {
            if (_disableDialog != value)
            {
                _disableDialog = value;
                StateChanged?.Invoke();
            }
        }
    }

    public bool DownPressed
    {
        get => _downPressed;
        set
        {
            if (_downPressed != value)
            {
                _downPressed = value;
                StateChanged?.Invoke();
            }
        }
    }

    public bool OutputToTestInput
    {
        get => _outputToTestInput;
        set
        {
            if (_outputToTestInput != value)
            {
                _outputToTestInput = value;
                StateChanged?.Invoke();
            }
        }
    }

    public event Action? StateChanged;

    public void Reset()
    {
        TestButtonStyle = TestConstants.Styles.TEST_BUTTON_GREEN;
        PassAnimation = TestConstants.Styles.PASS_ANIMATION_HIDDEN;
        ShowTable = false;
        ShowGraph = false;
        DisableDialog = false;
        DownPressed = false;
        OutputToTestInput = false;
    }

    public void SetButtonPressed()
    {
        TestButtonStyle = TestConstants.Styles.TEST_BUTTON_LIGHT_GREEN;
        DisableDialog = true;
        DownPressed = true;
    }

    public void SetButtonReleased()
    {
        TestButtonStyle = TestConstants.Styles.TEST_BUTTON_GREEN;
        DownPressed = false;
    }

    public void ToggleGraph()
    {
        ShowGraph = !ShowGraph;
    }
} 