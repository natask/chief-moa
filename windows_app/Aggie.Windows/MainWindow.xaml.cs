using Microsoft.UI.Xaml;
using Windows.ApplicationModel.DataTransfer;

namespace Aggie.Windows;

public sealed partial class MainWindow : Window
{
    private readonly DictationController controller = new();

    public MainWindow()
    {
        InitializeComponent();
        controller.StateChanged += snapshot => DispatcherQueue.TryEnqueue(() => Render(snapshot));
        Render(controller.Snapshot);
        Closed += async (_, _) => await controller.DisposeAsync();
    }

    private async void Start_Click(object sender, RoutedEventArgs e)
    {
        if (!Uri.TryCreate(GatewayOrigin.Text.Trim(), UriKind.Absolute, out var origin))
        {
            Status.Text = "Enter a valid HTTPS gateway origin.";
            return;
        }
        await controller.StartAsync(origin, GatewayCredential.Password);
    }

    private async void Cancel_Click(object sender, RoutedEventArgs e) => await controller.CancelAsync();
    private async void Pause_Click(object sender, RoutedEventArgs e) => await controller.PauseAsync();
    private async void Resume_Click(object sender, RoutedEventArgs e) => await controller.ResumeAsync();
    private async void Finish_Click(object sender, RoutedEventArgs e) => await controller.FinishAsync();
    private void Deny_Click(object sender, RoutedEventArgs e) => ApprovalStatus.Text = "Action denied; no local action ran.";
    private void Approve_Click(object sender, RoutedEventArgs e) => ApprovalStatus.Text = "Approved for final local checks; no demo effect runs.";

    private void Copy_Click(object sender, RoutedEventArgs e)
    {
        var text = Transcript.Text;
        if (string.IsNullOrWhiteSpace(text)) return;
        var package = new DataPackage();
        package.SetText(text);
        Clipboard.SetContent(package);
        Clipboard.Flush();
        Status.Text = "Copied the current edited text to the Windows clipboard.";
    }

    private void Render(DictationSnapshot snapshot)
    {
        Status.Text = snapshot.Status;
        DraftIdentity.Text = snapshot.DraftIdentity;
        if (snapshot.Transcript.Length > 0 && Transcript.Text != snapshot.Transcript)
            Transcript.Text = snapshot.Transcript;
        StartButton.IsEnabled = snapshot.CanStart;
        FinishButton.IsEnabled = snapshot.CanFinish;
        PauseButton.IsEnabled = snapshot.CanPause;
        ResumeButton.IsEnabled = snapshot.CanResume;
        CancelButton.IsEnabled = snapshot.CanCancel;
        CopyButton.IsEnabled = snapshot.CanCopy || !string.IsNullOrWhiteSpace(Transcript.Text);
    }
}
