$ports = @(3001, 5173, 5174)

foreach ($port in $ports) {
  $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

  foreach ($connection in $connections) {
    $processId = $connection.OwningProcess
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue

    if ($process) {
      Write-Host "Stopping $($process.ProcessName) on port $port (PID $processId)"
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
  }
}
