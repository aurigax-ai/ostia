set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin=${1:?path to the spike-input binary}
python3 -I "$here/scripts/atspi_dump.py" spike-input
