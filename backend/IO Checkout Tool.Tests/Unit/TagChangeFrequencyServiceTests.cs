using FluentAssertions;
using IO_Checkout_Tool.Services;
using IO_Checkout_Tool.Services.Interfaces;
using Moq;
using Shared.Library.Models.Entities;
using Xunit;

namespace IO_Checkout_Tool.Tests.Unit;

public class TagChangeFrequencyServiceTests : IDisposable
{
    private readonly Mock<ITagReaderService> _tagReaderMock;
    private readonly TagChangeFrequencyService _sut;

    public TagChangeFrequencyServiceTests()
    {
        _tagReaderMock = new Mock<ITagReaderService>();
        _sut = new TagChangeFrequencyService(_tagReaderMock.Object);
    }

    public void Dispose()
    {
        _sut.Dispose();
        GC.SuppressFinalize(this);
    }

    private static Io CreateIo(int id, string? name = null)
    {
        return new Io
        {
            Id = id,
            SubsystemId = 1,
            Name = name ?? $"Tag_{id}",
            Description = $"Description {id}"
        };
    }

    private void RaiseTagValueChanged(Io io)
    {
        _tagReaderMock.Raise(x => x.TagValueChanged += null, io);
    }

    [Fact]
    public void GetHz_UnknownIoId_ReturnsZero()
    {
        _sut.GetHz(99).Should().Be(0);
    }

    [Fact]
    public void GetHz_AfterOneTagValueChanged_ReturnsOneTenthHz()
    {
        var io = CreateIo(1);
        RaiseTagValueChanged(io);

        _sut.GetHz(1).Should().BeApproximately(0.1, 0.001); // 1 change (half cycle) in 5s window = 0.1 Hz
    }

    [Fact]
    public void GetHz_AfterTwoTagValueChanged_ReturnsOneFifthHz()
    {
        var io = CreateIo(1);
        RaiseTagValueChanged(io);
        RaiseTagValueChanged(io);

        _sut.GetHz(1).Should().BeApproximately(0.2, 0.001); // 2 changes (full cycle) in 5s window = 0.2 Hz
    }

    [Fact]
    public void GetHz_AfterMultipleChangesSameIo_ReturnsProportionalFrequency()
    {
        var io = CreateIo(1);
        for (int i = 0; i < 10; i++)
            RaiseTagValueChanged(io);

        _sut.GetHz(1).Should().BeApproximately(1.0, 0.001); // 10 changes (5 cycles) in 5s = 1.0 Hz
    }

    [Fact]
    public void GetHz_DifferentIos_TracksSeparately()
    {
        RaiseTagValueChanged(CreateIo(1));
        RaiseTagValueChanged(CreateIo(1));
        RaiseTagValueChanged(CreateIo(2));

        _sut.GetHz(1).Should().BeApproximately(0.2, 0.001);  // 1 cycle / 5 seconds = 0.2 Hz
        _sut.GetHz(2).Should().BeApproximately(0.1, 0.001);  // 1/2 cycle / 5 seconds = 0.1 Hz
        _sut.GetHz(3).Should().Be(0);
    }

    [Fact]
    public void AnyHzUpdated_RaisedWhenTimerFiresWithActiveIo()
    {
        var raised = false;
        _sut.AnyHzUpdated += () => raised = true;

        RaiseTagValueChanged(CreateIo(1));
        // Timer runs every 500ms; wait for at least one tick
        Thread.Sleep(600);

        raised.Should().BeTrue();
    }

    [Fact]
    public void HzUpdated_RaisedWithCorrectIoIdWhenTimerFires()
    {
        var raisedIds = new List<int>();
        _sut.HzUpdated += id => raisedIds.Add(id);

        RaiseTagValueChanged(CreateIo(1));
        RaiseTagValueChanged(CreateIo(2));
        Thread.Sleep(600);

        raisedIds.Should().Contain(1);
        raisedIds.Should().Contain(2);
    }

    [Fact]
    public void Dispose_DoesNotThrow()
    {
        var act = () => _sut.Dispose();
        act.Should().NotThrow();
    }

    [Fact]
    public void Dispose_SecondCall_DoesNotThrow()
    {
        _sut.Dispose();
        var act = () => _sut.Dispose();
        act.Should().NotThrow();
    }

    [Fact]
    public void AfterDispose_GetHz_StillReturnsValueForPreviouslyRecordedIo()
    {
        RaiseTagValueChanged(CreateIo(1));
        _sut.GetHz(1).Should().BeApproximately(0.1, 0.001);

        _sut.Dispose();

        // Data recorded before dispose is still there (timer is stopped so no prune)
        _sut.GetHz(1).Should().BeApproximately(0.1, 0.001);
    }
}
