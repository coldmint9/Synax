// macOS footprint, resident bytes and cumulative CPU/I/O without suspending the target.
// Build: clang -O2 scripts/runtime-process-sampler.c -o /tmp/runtime-process-sampler
#include <libproc.h>
#include <sys/resource.h>
#include <sys/proc_info.h>
#include <time.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <inttypes.h>
#include <mach/mach_time.h>

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    setvbuf(stdout, NULL, _IOLBF, 0);
    for (;;) {
        int alive = 0;
        struct timespec now;
        clock_gettime(CLOCK_REALTIME, &now);
        for (int i = 1; i < argc; i++) {
            int pid = atoi(argv[i]);
            struct rusage_info_v4 info = {0};
            if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&info) != 0) continue;
            alive++;
            struct proc_taskinfo task = {0};
            proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, sizeof(task));
            printf("{\"at\":%.3f,\"pid\":%d,\"footprint\":%" PRIu64
                   ",\"resident\":%" PRIu64 ",\"peakFootprint\":%" PRIu64
                   ",\"cpuNs\":%" PRIu64 ",\"readBytes\":%" PRIu64
                   ",\"writeBytes\":%" PRIu64 ",\"pageins\":%" PRIu64 ",\"threads\":%d}\n",
                   now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0, pid,
                   info.ri_phys_footprint, info.ri_resident_size, info.ri_lifetime_max_phys_footprint,
                   (uint64_t)(((__uint128_t)info.ri_user_time + info.ri_system_time) * timebase.numer / timebase.denom), info.ri_diskio_bytesread,
                   info.ri_diskio_byteswritten, info.ri_pageins, task.pti_threadnum);
        }
        if (!alive) break;
        usleep(250000);
    }
    return 0;
}
