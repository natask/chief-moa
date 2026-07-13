using Microsoft.UI.Xaml;

namespace Aggie.Windows;

public sealed partial class MainWindow : Window
{
    public MainWindow() => InitializeComponent();
    private void Deny_Click(object sender, RoutedEventArgs e) => Status.Text = "Action denied; no local action ran.";
    private void Approve_Click(object sender, RoutedEventArgs e) => Status.Text = "Approved for final local checks; no demo effect runs.";
}
